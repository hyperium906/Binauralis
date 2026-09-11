import {
    StemName,
    STEM_NAMES,
    STEM_INDEX_MAP,
    Position3D,
    MasterLoudnessMetrics,
    HRIRTableData,
    WorkletInboundMessage,
    WorkletOutboundMessage
} from './types.js';

export interface SpatialAudioEngineOptions {
    targetSampleRate?: number;
    wasmUrl?: string;
    workletUrl?: string;
    hrirData?: HRIRTableData;
    onSampleRateMismatch?: (actualSr: number, targetSr: number) => void;
    onError?: (error: Error) => void;
}

export class SpatialAudioEngine {
    private audioContext: AudioContext | null = null;
    private workletNode: AudioWorkletNode | null = null;
    private masterGainNode: GainNode | null = null;
    private analyserNode: AnalyserNode | null = null;

    private readonly targetSampleRate: number;
    private readonly wasmUrl: string;
    private readonly workletUrl: string;
    private hrirData?: HRIRTableData;

    private onSampleRateMismatch?: (actualSr: number, targetSr: number) => void;
    private onError?: (error: Error) => void;

    // Stem buffers and active graph nodes
    private stemBuffers: Map<StemName, AudioBuffer> = new Map();
    private stemSourceNodes: Map<StemName, AudioBufferSourceNode> = new Map();
    private stemGainNodes: Map<StemName, GainNode> = new Map();
    private stemPositions: Map<StemName, Position3D> = new Map();

    // Transport state
    private isPlaying: boolean = false;
    private playbackStartTime: number = 0;
    private playbackOffset: number = 0;
    private trackDuration: number = 0;

    // Scratchpad for master loudness telemetry (zero GC during polling)
    private timeDomainScratch: Float32Array = new Float32Array(2048);

    constructor(options: SpatialAudioEngineOptions = {}) {
        this.targetSampleRate = options.targetSampleRate || 48000;
        this.wasmUrl = options.wasmUrl || '/build/aurastream_standalone.wasm';
        this.workletUrl = options.workletUrl || '/web/SpatialWorkletProcessor.js';
        this.hrirData = options.hrirData;
        this.onSampleRateMismatch = options.onSampleRateMismatch;
        this.onError = options.onError;

        // Default initial spatial positions (surround quadrant)
        this.stemPositions.set('drums', { x: -1.0, y: 1.5, z: 0.0 });   // Front-left
        this.stemPositions.set('bass', { x: 0.0, y: 1.0, z: -0.5 });    // Front-center low
        this.stemPositions.set('vocals', { x: 0.0, y: 2.0, z: 0.3 });   // Center stage
        this.stemPositions.set('other', { x: 1.2, y: 1.5, z: 0.2 });    // Front-right
    }

    /**
     * @brief Initialize AudioContext and register AudioWorkletProcessor.
     * Manages hardware sample-rate mismatch and pre-compiles Wasm module.
     */
    public async initialize(): Promise<void> {
        if (this.audioContext && this.workletNode) {
            return;
        }

        // 1. Instantiate AudioContext with sampleRate preference
        try {
            const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
            this.audioContext = new AudioCtx({
                sampleRate: this.targetSampleRate,
                latencyHint: 'interactive'
            });
        } catch (err) {
            console.warn('[SpatialAudioEngine] Browser rejected custom sampleRate; creating default context.');
            this.audioContext = new AudioContext();
        }

        const actualSr = this.audioContext.sampleRate;
        if (actualSr !== this.targetSampleRate) {
            console.warn(
                `[SpatialAudioEngine] Hardware sample rate mismatch: Hardware is ${actualSr} Hz, expected ${this.targetSampleRate} Hz.`
            );
            if (this.onSampleRateMismatch) {
                this.onSampleRateMismatch(actualSr, this.targetSampleRate);
            }
            // If custom HRIR is loaded, resample to match active AudioContext
            if (this.hrirData) {
                this.hrirData = await this.resampleHrirData(this.hrirData, actualSr);
            }
        }

        // 2. Register AudioWorklet processor module
        try {
            await this.audioContext.audioWorklet.addModule(this.workletUrl);
        } catch (err) {
            const error = new Error(`Failed to load AudioWorklet module from ${this.workletUrl}: ${err}`);
            if (this.onError) this.onError(error);
            throw error;
        }

        // 3. Compile WebAssembly module on main thread
        let wasmModule: WebAssembly.Module;
        try {
            const wasmResponse = await fetch(this.wasmUrl);
            if (!wasmResponse.ok) {
                throw new Error(`HTTP ${wasmResponse.status} fetching ${this.wasmUrl}`);
            }
            const wasmBytes = await wasmResponse.arrayBuffer();
            wasmModule = await WebAssembly.compile(wasmBytes);
        } catch (err) {
            const error = new Error(`Failed to compile WebAssembly binary: ${err}`);
            if (this.onError) this.onError(error);
            throw error;
        }

        // 4. Construct AudioWorkletNode (4 inputs for stems -> 1 stereo output)
        this.workletNode = new AudioWorkletNode(this.audioContext, 'spatial-worklet-processor', {
            numberOfInputs: 4,
            numberOfOutputs: 1,
            outputChannelCount: [2]
        });

        // 5. Connect downstream master chain: Worklet -> MasterGain -> Analyser -> Destination
        this.masterGainNode = this.audioContext.createGain();
        this.analyserNode = this.audioContext.createAnalyser();
        this.analyserNode.fftSize = 2048;

        this.workletNode.connect(this.masterGainNode);
        this.masterGainNode.connect(this.analyserNode);
        this.analyserNode.connect(this.audioContext.destination);

        // 6. Pre-create individual GainNodes per stem
        for (let i = 0; i < STEM_NAMES.length; ++i) {
            const stem = STEM_NAMES[i];
            const gain = this.audioContext.createGain();
            gain.gain.value = 1.0;
            // Connect to worklet input pin i
            gain.connect(this.workletNode, 0, i);
            this.stemGainNodes.set(stem, gain);
        }

        // 7. Initialize Wasm in the AudioWorklet
        const initMessage: WorkletInboundMessage = {
            type: 'INIT_WASM',
            wasmModule,
            hrirData: this.hrirData,
            sampleRate: actualSr
        };

        this.workletNode.port.postMessage(initMessage);

        // Sync initial spatial coordinates to worklet
        for (const [stem, pos] of this.stemPositions.entries()) {
            this.setStemPosition(stem, pos.x, pos.y, pos.z);
        }

        console.info('[SpatialAudioEngine] Initialized successfully at', actualSr, 'Hz');
    }

    /**
     * @brief Load and decode an audio stem from URL or ArrayBuffer.
     */
    public async loadStem(stemName: StemName, source: string | ArrayBuffer): Promise<void> {
        if (!this.audioContext) {
            await this.initialize();
        }

        let arrayBuffer: ArrayBuffer;
        if (typeof source === 'string') {
            const res = await fetch(source);
            if (!res.ok) throw new Error(`Failed to fetch stem ${stemName} from ${source}`);
            arrayBuffer = await res.arrayBuffer();
        } else {
            arrayBuffer = source;
        }

        const decodedBuffer = await this.audioContext!.decodeAudioData(arrayBuffer.slice(0));
        this.stemBuffers.set(stemName, decodedBuffer);

        if (decodedBuffer.duration > this.trackDuration) {
            this.trackDuration = decodedBuffer.duration;
        }

        console.info(`[SpatialAudioEngine] Loaded stem '${stemName}': ${decodedBuffer.duration.toFixed(2)}s`);
    }

    /**
     * @brief Load all 4 stems simultaneously from dictionary of URLs.
     */
    public async loadAllStems(stems: Record<StemName, string>): Promise<void> {
        const promises = Object.entries(stems).map(([name, url]) =>
            this.loadStem(name as StemName, url)
        );
        await Promise.all(promises);
    }

    /**
     * @brief Synchronized Start Transport across all four stems using currentTime scheduling.
     */
    public async play(offsetSec: number = 0): Promise<void> {
        if (!this.audioContext || !this.workletNode) {
            await this.initialize();
        }

        if (this.isPlaying) return;

        if (this.audioContext!.state === 'suspended') {
            await this.audioContext!.resume();
        }

        // Schedule start with 50ms lookahead for sample-accurate synchronization across stems
        const scheduleLookahead = 0.05;
        const startTime = this.audioContext!.currentTime + scheduleLookahead;
        const actualOffset = Math.max(0, offsetSec || this.playbackOffset);

        for (const stem of STEM_NAMES) {
            const buffer = this.stemBuffers.get(stem);
            if (!buffer) continue;

            const sourceNode = this.audioContext!.createBufferSource();
            sourceNode.buffer = buffer;

            const gainNode = this.stemGainNodes.get(stem);
            if (gainNode) {
                sourceNode.connect(gainNode);
            }

            sourceNode.start(startTime, actualOffset);
            this.stemSourceNodes.set(stem, sourceNode);
        }

        this.playbackStartTime = startTime - actualOffset;
        this.isPlaying = true;
    }

    /**
     * @brief Pause synchronized playback and record position.
     */
    public pause(): void {
        if (!this.isPlaying || !this.audioContext) return;

        this.playbackOffset = this.getCurrentTime();
        this.stopSourceNodes();
        this.isPlaying = false;
    }

    /**
     * @brief Stop playback and reset playhead to beginning.
     */
    public stop(): void {
        this.stopSourceNodes();
        this.playbackOffset = 0;
        this.isPlaying = false;
    }

    /**
     * @brief Seek to a specific timestamp in seconds.
     */
    public async seek(targetSeconds: number): Promise<void> {
        const wasPlaying = this.isPlaying;
        if (wasPlaying) {
            this.stopSourceNodes();
            this.isPlaying = false;
        }
        this.playbackOffset = Math.max(0, Math.min(targetSeconds, this.trackDuration));
        if (wasPlaying) {
            await this.play(this.playbackOffset);
        }
    }

    /**
     * @brief Update 3D position coordinates for an individual stem.
     */
    public setStemPosition(stemName: StemName, x: number, y: number, z: number): void {
        const sourceId = STEM_INDEX_MAP[stemName];
        this.stemPositions.set(stemName, { x, y, z });

        if (this.workletNode) {
            const msg: WorkletInboundMessage = {
                type: 'SET_POSITION',
                sourceId,
                stemName,
                x,
                y,
                z
            };
            this.workletNode.port.postMessage(msg);
        }
    }

    /**
     * @brief Set individual volume gain for a stem (0.0 to 1.0).
     */
    public setStemVolume(stemName: StemName, volume: number): void {
        const gainNode = this.stemGainNodes.get(stemName);
        if (gainNode && this.audioContext) {
            gainNode.gain.setTargetAtTime(Math.max(0, volume), this.audioContext.currentTime, 0.02);
        }
    }

    /**
     * @brief Set master output volume.
     */
    public setMasterVolume(volume: number): void {
        if (this.masterGainNode && this.audioContext) {
            this.masterGainNode.gain.setTargetAtTime(Math.max(0, volume), this.audioContext.currentTime, 0.02);
        }
    }

    /**
     * @brief Calculate real-time master output loudness (RMS and Peak dBFS).
     */
    public getMasterLoudness(): MasterLoudnessMetrics {
        if (!this.analyserNode || !this.audioContext) {
            return { rmsDbfs: -120, peakDbfs: -120, sampleRate: 48000, isClipping: false };
        }

        this.analyserNode.getFloatTimeDomainData(this.timeDomainScratch);
        const len = this.timeDomainScratch.length;

        let sumSquares = 0.0;
        let peak = 0.0;

        for (let i = 0; i < len; ++i) {
            const val = this.timeDomainScratch[i];
            const absVal = Math.abs(val);
            if (absVal > peak) peak = absVal;
            sumSquares += val * val;
        }

        const rms = Math.sqrt(sumSquares / len);
        const rmsDbfs = rms > 1e-6 ? 20.0 * Math.log10(rms) : -120.0;
        const peakDbfs = peak > 1e-6 ? 20.0 * Math.log10(peak) : -120.0;

        return {
            rmsDbfs: Math.round(rmsDbfs * 10) / 10,
            peakDbfs: Math.round(peakDbfs * 10) / 10,
            sampleRate: this.audioContext.sampleRate,
            isClipping: peak >= 0.999
        };
    }

    public getCurrentTime(): number {
        if (!this.isPlaying || !this.audioContext) {
            return this.playbackOffset;
        }
        return this.audioContext.currentTime - this.playbackStartTime;
    }

    public getDuration(): number {
        return this.trackDuration;
    }

    public getStemPosition(stemName: StemName): Position3D | undefined {
        return this.stemPositions.get(stemName);
    }

    private stopSourceNodes(): void {
        for (const [stem, node] of this.stemSourceNodes.entries()) {
            try {
                node.stop();
                node.disconnect();
            } catch (err) {
                // Ignore if already stopped
            }
        }
        this.stemSourceNodes.clear();
    }

    /**
     * @brief In-memory OfflineAudioContext resampler for HRIR arrays when hardware sample rate mismatches.
     */
    private async resampleHrirData(hrir: HRIRTableData, targetSr: number): Promise<HRIRTableData> {
        const sourceSr = 48000; // Native DSP filter sample rate
        const ratio = targetSr / sourceSr;
        const newFilterLen = Math.round(hrir.filterLen * ratio);
        const newTotalFloats = hrir.numPositions * newFilterLen;

        const resampledLeft = new Float32Array(newTotalFloats);
        const resampledRight = new Float32Array(newTotalFloats);

        // Resample each filter position using OfflineAudioContext
        for (let p = 0; p < hrir.numPositions; ++p) {
            const offlineCtx = new OfflineAudioContext(2, newFilterLen, targetSr);
            const srcBuffer = offlineCtx.createBuffer(2, hrir.filterLen, sourceSr);

            const leftSlice = hrir.leftHrir.subarray(p * hrir.filterLen, (p + 1) * hrir.filterLen);
            const rightSlice = hrir.rightHrir.subarray(p * hrir.filterLen, (p + 1) * hrir.filterLen);

            srcBuffer.copyToChannel(leftSlice, 0);
            srcBuffer.copyToChannel(rightSlice, 1);

            const sourceNode = offlineCtx.createBufferSource();
            sourceNode.buffer = srcBuffer;
            sourceNode.connect(offlineCtx.destination);
            sourceNode.start(0);

            const renderedBuffer = await offlineCtx.startRendering();
            renderedBuffer.copyFromChannel(resampledLeft.subarray(p * newFilterLen, (p + 1) * newFilterLen), 0);
            renderedBuffer.copyFromChannel(resampledRight.subarray(p * newFilterLen, (p + 1) * newFilterLen), 1);
        }

        return {
            leftHrir: resampledLeft,
            rightHrir: resampledRight,
            numPositions: hrir.numPositions,
            filterLen: newFilterLen
        };
    }
}
