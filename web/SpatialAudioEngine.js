import { STEM_NAMES, STEM_INDEX_MAP } from './types.js';
const SHORT_TERM_RING_LEN = 60; // 3.0s at 20 Hz polling
export class SpatialAudioEngine {
    audioContext = null;
    workletNode = null;
    masterGainNode = null;
    analyserNode = null;
    // Stereo peak + ITU-R BS.1770-4 K-weighted sidechain analysers
    leftPeakAnalyser = null;
    rightPeakAnalyser = null;
    kLeftAnalyser = null;
    kRightAnalyser = null;
    kPowerRing = new Float32Array(SHORT_TERM_RING_LEN);
    kPowerWriteIdx = 0;
    kPowerCount = 0;
    targetSampleRate;
    wasmUrl;
    workletUrl;
    hrirData;
    dspBackend = 'worklet-dsp';
    onSampleRateMismatch;
    onError;
    onPlaybackEnded;
    // Stem buffers and active graph nodes
    stemBuffers = new Map();
    stemSourceNodes = new Map();
    stemGainNodes = new Map();
    stemAnalyserNodes = new Map();
    stemPositions = new Map();
    stemVolumes = new Map();
    // Transport state
    isPlaying = false;
    loopEnabled = false;
    playbackStartTime = 0;
    playbackOffset = 0;
    trackDuration = 0;
    playbackGeneration = 0;
    pendingTransportTimer = null;
    // Pre-allocated scratchpads (zero GC during 20Hz metering)
    timeDomainScratch = new Float32Array(2048);
    timeDomainScratchR = new Float32Array(2048);
    stemScratch = new Float32Array(256);
    constructor(options = {}) {
        this.targetSampleRate = options.targetSampleRate || 48000;
        this.wasmUrl = options.wasmUrl || '/aurastream_standalone.wasm';
        this.workletUrl = options.workletUrl || '/SpatialWorkletProcessor.js';
        this.hrirData = options.hrirData;
        this.onSampleRateMismatch = options.onSampleRateMismatch;
        this.onError = options.onError;
        this.onPlaybackEnded = options.onPlaybackEnded;
        // Default initial spatial positions (matches web tests & studio layout)
        this.stemPositions.set('drums', { x: -1.0, y: 1.5, z: 0.0 });
        this.stemPositions.set('bass', { x: 0.0, y: 1.0, z: -0.5 });
        this.stemPositions.set('vocals', { x: 0.0, y: 2.0, z: 0.3 });
        this.stemPositions.set('other', { x: 1.2, y: 1.5, z: 0.2 });
        for (const stem of STEM_NAMES) {
            this.stemVolumes.set(stem, 1.0);
        }
    }
    /**
     * Initialize AudioContext and register AudioWorkletProcessor.
     * Attempts compiled C++ WebAssembly first; falls back seamlessly to the
     * zero-allocation Worklet 1024-pt FFT Overlap-Add DSP when .wasm is absent.
     */
    async initialize() {
        if (this.audioContext && this.workletNode) {
            return;
        }
        // 1. Instantiate AudioContext with 48kHz preference
        try {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            this.audioContext = new AudioCtx({
                sampleRate: this.targetSampleRate,
                latencyHint: 'interactive'
            });
        }
        catch {
            console.warn('[SpatialAudioEngine] Browser rejected custom sampleRate; creating default context.');
            this.audioContext = new AudioContext();
        }
        const actualSr = this.audioContext.sampleRate;
        if (actualSr !== this.targetSampleRate) {
            console.warn(`[SpatialAudioEngine] Hardware sample rate mismatch: Hardware is ${actualSr} Hz, expected ${this.targetSampleRate} Hz.`);
            if (this.onSampleRateMismatch) {
                this.onSampleRateMismatch(actualSr, this.targetSampleRate);
            }
            if (this.hrirData) {
                this.hrirData = await this.resampleHrirData(this.hrirData, actualSr);
            }
        }
        // 2. Register AudioWorklet processor module
        try {
            await this.audioContext.audioWorklet.addModule(this.workletUrl);
        }
        catch (err) {
            const error = new Error(`Failed to load AudioWorklet module from ${this.workletUrl}: ${err}`);
            if (this.onError)
                this.onError(error);
            throw error;
        }
        // 3. Try fetching & compiling standalone WebAssembly binary; allow clean DSP fallback
        let wasmModule = null;
        try {
            const wasmResponse = await fetch(this.wasmUrl);
            if (wasmResponse.ok) {
                const contentType = wasmResponse.headers.get('content-type') || '';
                const wasmBytes = await wasmResponse.arrayBuffer();
                const view = new Uint8Array(wasmBytes);
                // Verify Wasm magic bytes (\0asm) before compiling (guards against HTML 404 pages)
                if (view.length >= 4 &&
                    view[0] === 0x00 &&
                    view[1] === 0x61 &&
                    view[2] === 0x73 &&
                    view[3] === 0x6d &&
                    !contentType.includes('text/html')) {
                    wasmModule = await WebAssembly.compile(wasmBytes);
                }
            }
        }
        catch {
            wasmModule = null;
        }
        // 4. Construct AudioWorkletNode (4 stem inputs -> 1 stereo binaural output)
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
        // 5b. Attach stereo peak + ITU-R BS.1770-4 K-weighted sidechain meters when supported
        if (typeof this.audioContext.createChannelSplitter === 'function' &&
            typeof this.audioContext.createBiquadFilter === 'function') {
            const peakSplit = this.audioContext.createChannelSplitter(2);
            this.leftPeakAnalyser = this.audioContext.createAnalyser();
            this.rightPeakAnalyser = this.audioContext.createAnalyser();
            this.leftPeakAnalyser.fftSize = 2048;
            this.rightPeakAnalyser.fftSize = 2048;
            this.masterGainNode.connect(peakSplit);
            peakSplit.connect(this.leftPeakAnalyser, 0);
            peakSplit.connect(this.rightPeakAnalyser, 1);
            // BS.1770-4 Stage 1 (+4 dB high shelf @ 1500 Hz) + Stage 2 (RLB highpass @ 38.135 Hz)
            const kShelf = this.audioContext.createBiquadFilter();
            kShelf.type = 'highshelf';
            kShelf.frequency.value = 1500;
            kShelf.gain.value = 4.0;
            const kHighPass = this.audioContext.createBiquadFilter();
            kHighPass.type = 'highpass';
            kHighPass.frequency.value = 38.135;
            kHighPass.Q.value = 0.5003;
            const kSplit = this.audioContext.createChannelSplitter(2);
            this.kLeftAnalyser = this.audioContext.createAnalyser();
            this.kRightAnalyser = this.audioContext.createAnalyser();
            this.kLeftAnalyser.fftSize = 2048;
            this.kRightAnalyser.fftSize = 2048;
            this.masterGainNode.connect(kShelf);
            kShelf.connect(kHighPass);
            kHighPass.connect(kSplit);
            kSplit.connect(this.kLeftAnalyser, 0);
            kSplit.connect(this.kRightAnalyser, 1);
        }
        // 6. Pre-create per-stem GainNode -> AnalyserNode -> Worklet input pin i
        for (let i = 0; i < STEM_NAMES.length; ++i) {
            const stem = STEM_NAMES[i];
            const gain = this.audioContext.createGain();
            gain.gain.value = this.stemVolumes.get(stem) ?? 1.0;
            const analyser = this.audioContext.createAnalyser();
            analyser.fftSize = 256;
            gain.connect(analyser);
            analyser.connect(this.workletNode, 0, i);
            this.stemGainNodes.set(stem, gain);
            this.stemAnalyserNodes.set(stem, analyser);
        }
        // 7. Initialize DSP engine inside the AudioWorklet and await handshake
        const readyPromise = new Promise((resolve, reject) => {
            const port = this.workletNode.port;
            const timeoutId = setTimeout(() => resolve(), 600);
            port.onmessage = (evt) => {
                const data = evt.data;
                if (!data)
                    return;
                if (data.type === 'ENGINE_INITIALIZED') {
                    clearTimeout(timeoutId);
                    this.dspBackend = data.backend || (wasmModule ? 'wasm' : 'worklet-dsp');
                    resolve();
                }
                else if (data.type === 'ENGINE_ERROR') {
                    clearTimeout(timeoutId);
                    reject(new Error(data.error));
                }
            };
        });
        const initMessage = wasmModule
            ? {
                type: 'INIT_WASM',
                wasmModule,
                hrirData: this.hrirData,
                sampleRate: actualSr
            }
            : {
                type: 'INIT_JS_DSP',
                hrirData: this.hrirData,
                sampleRate: actualSr
            };
        this.dspBackend = wasmModule ? 'wasm' : 'worklet-dsp';
        this.workletNode.port.postMessage(initMessage);
        await readyPromise;
        // 8. Sync initial spatial coordinates into the DSP engine
        for (const [stem, pos] of this.stemPositions.entries()) {
            this.setStemPosition(stem, pos.x, pos.y, pos.z);
        }
        console.info(`[SpatialAudioEngine] Initialized (${this.dspBackend}) at ${actualSr} Hz`);
    }
    /**
     * Load and decode an audio stem from URL or ArrayBuffer.
     */
    async loadStem(stemName, source) {
        if (!this.audioContext) {
            await this.initialize();
        }
        let arrayBuffer;
        if (typeof source === 'string') {
            const res = await fetch(source);
            if (!res.ok)
                throw new Error(`Failed to fetch stem ${stemName} from ${source} (HTTP ${res.status})`);
            arrayBuffer = await res.arrayBuffer();
        }
        else {
            arrayBuffer = source;
        }
        const decodedBuffer = await this.audioContext.decodeAudioData(arrayBuffer.slice(0));
        this.stemBuffers.set(stemName, decodedBuffer);
        this.recalculateDuration();
    }
    /**
     * Load all 4 stems simultaneously from a dictionary of URLs.
     */
    async loadAllStems(stems) {
        if (!this.audioContext) {
            await this.initialize();
        }
        this.stop();
        this.stemBuffers.clear();
        this.trackDuration = 0;
        this.loopEnabled = false;
        const promises = STEM_NAMES.map((name) => this.loadStem(name, stems[name]));
        await Promise.all(promises);
        this.recalculateDuration();
    }
    /**
     * Synthesize a musical, phase-aligned 4-stem 16-second studio reference loop
     * directly in memory so users can audition live binaural spatialization immediately.
     */
    async loadReferenceMix() {
        if (!this.audioContext) {
            await this.initialize();
        }
        this.stop();
        const ctx = this.audioContext;
        const sr = ctx.sampleRate;
        const durationSec = 16.0; // Exact 8 bars at 120 BPM
        const totalSamples = Math.round(sr * durationSec);
        const beatSec = 0.5; // 120 BPM
        const makeBuf = () => ctx.createBuffer(2, totalSamples, sr);
        const bassBuf = makeBuf();
        const drumsBuf = makeBuf();
        const otherBuf = makeBuf();
        const vocalsBuf = makeBuf();
        const bL = bassBuf.getChannelData(0);
        const bR = bassBuf.getChannelData(1);
        const dL = drumsBuf.getChannelData(0);
        const dR = drumsBuf.getChannelData(1);
        const oL = otherBuf.getChannelData(0);
        const oR = otherBuf.getChannelData(1);
        const vL = vocalsBuf.getChannelData(0);
        const vR = vocalsBuf.getChannelData(1);
        // Chord progression (2 bars each): Dm9 -> Bbmaj7 -> Gm7 -> A7sus4
        const bassRoots = [73.42, 73.42, 58.27, 58.27, 98.0, 98.0, 110.0, 82.41]; // Hz per bar
        const chords = [
            [293.66, 349.23, 440.0, 523.25, 659.25], // Dm9
            [233.08, 293.66, 349.23, 440.0, 587.33], // Bbmaj7
            [196.0, 233.08, 293.66, 349.23, 523.25], // Gm7
            [220.0, 293.66, 329.63, 392.0, 523.25] // A7sus4
        ];
        // Vocal formant motif notes (Hz) per half-beat (32 steps across 8 bars = 16 half-bars)
        const melodyHz = [
            587.33, 0, 659.25, 698.46, 659.25, 587.33, 523.25, 0,
            587.33, 0, 523.25, 440.0, 466.16, 440.0, 392.0, 0,
            440.0, 0, 523.25, 587.33, 523.25, 466.16, 440.0, 0,
            523.25, 0, 587.33, 659.25, 587.33, 523.25, 440.0, 0
        ];
        // Deterministic PRNG for clean percussion transients
        let rng = 0x1337c0de;
        const nextNoise = () => {
            rng = (Math.imul(1664525, rng) + 1013904223) >>> 0;
            return (rng / 0xffffffff) * 2 - 1;
        };
        let snareLp = 0;
        let hatHpPrev = 0;
        let hatPrevIn = 0;
        for (let i = 0; i < totalSamples; ++i) {
            const t = i / sr;
            const beatPos = t / beatSec;
            const barIdx = Math.min(7, Math.floor(beatPos / 4));
            const beatInBar = beatPos - barIdx * 4;
            const subBeat = beatPos - Math.floor(beatPos);
            const sixteenth = (beatPos * 4) % 1;
            const sixteenthIdx = Math.floor(beatPos * 4) % 16;
            // --- 1. Bass (< 250 Hz): warm sub + 2nd harmonic pluck ---
            const bassFreq = bassRoots[barIdx];
            const bassSlot = beatInBar % 1.0;
            const bassEnv = Math.exp(-4.2 * bassSlot) * Math.min(1, bassSlot * 90);
            const bassSig = (0.72 * Math.sin(2 * Math.PI * bassFreq * t) +
                0.22 * Math.sin(4 * Math.PI * bassFreq * t) * Math.exp(-8 * bassSlot)) *
                bassEnv *
                0.34;
            bL[i] = bassSig;
            bR[i] = bassSig;
            // --- 2. Drums (Broadband transients): kick + snare + 16th hi-hat ---
            const kickTime = (Math.floor(beatInBar) === 0 || Math.floor(beatInBar) === 2)
                ? subBeat * beatSec
                : (sixteenthIdx === 10 ? sixteenth * beatSec * 0.25 : 1.0);
            const kickEnv = kickTime < 0.35 ? Math.exp(-13.0 * kickTime) : 0;
            const kickPhase = 2 * Math.PI * (48 * kickTime + (115 / 26) * (1 - Math.exp(-26 * kickTime)));
            const kick = Math.sin(kickPhase) * kickEnv * 0.42;
            const snareTime = (Math.floor(beatInBar) === 1 || Math.floor(beatInBar) === 3)
                ? subBeat * beatSec
                : 1.0;
            const n = nextNoise();
            snareLp += 0.28 * (n - snareLp);
            const snareEnv = snareTime < 0.22 ? Math.exp(-22 * snareTime) : 0;
            const snareBody = Math.sin(2 * Math.PI * 195 * snareTime) * Math.exp(-32 * snareTime);
            const snare = (snareLp * 0.72 + snareBody * 0.45) * snareEnv * 0.28;
            const hatTime = sixteenth * (beatSec * 0.25);
            const hatHp = 0.86 * (hatHpPrev + n - hatPrevIn);
            hatHpPrev = hatHp;
            hatPrevIn = n;
            const hatAccent = sixteenthIdx % 4 === 2 ? 1.0 : 0.45;
            const hatEnv = Math.exp(-85 * hatTime);
            const hat = hatHp * hatEnv * hatAccent * 0.14;
            const drumMix = kick + snare + hat;
            dL[i] = drumMix;
            dR[i] = drumMix;
            // --- 3. Instruments (250 Hz - 4 kHz): warm electric-piano chord pad ---
            const chordIdx = Math.min(3, Math.floor(barIdx / 2));
            const chord = chords[chordIdx];
            const barPairT = t - chordIdx * 4.0;
            const padEnv = Math.min(1, barPairT * 4.0) * Math.exp(-0.22 * barPairT) * (1 - Math.max(0, (barPairT - 3.85) / 0.15));
            let chordSum = 0;
            for (let c = 0; c < chord.length; ++c) {
                const f = chord[c];
                chordSum += Math.sin(2 * Math.PI * f * t) * 0.72 + Math.sin(4 * Math.PI * f * t) * 0.14 * Math.exp(-1.2 * barPairT);
            }
            const otherSig = (chordSum / chord.length) * Math.max(0, padEnv) * 0.30;
            oL[i] = otherSig;
            oR[i] = otherSig;
            // --- 4. Vocals (1 - 6 kHz presence): airy formant lead motif ---
            const stepIdx = Math.min(melodyHz.length - 1, Math.floor(t / 0.5));
            const stepT = t - stepIdx * 0.5;
            const f0 = melodyHz[stepIdx];
            let vocSig = 0;
            if (f0 > 0) {
                const vibrato = 1 + 0.004 * Math.sin(2 * Math.PI * 5.2 * t);
                const env = Math.min(1, stepT / 0.035) * Math.exp(-3.4 * stepT) * Math.min(1, (0.5 - stepT) / 0.03);
                const fm = f0 * vibrato;
                vocSig = (0.55 * Math.sin(2 * Math.PI * fm * t) +
                    0.30 * Math.sin(2 * Math.PI * fm * 2 * t) +
                    0.18 * Math.sin(2 * Math.PI * fm * 3 * t) +
                    0.08 * Math.sin(2 * Math.PI * fm * 4 * t)) * Math.max(0, env) * 0.24;
            }
            vL[i] = vocSig;
            vR[i] = vocSig;
        }
        this.stemBuffers.clear();
        this.stemBuffers.set('bass', bassBuf);
        this.stemBuffers.set('drums', drumsBuf);
        this.stemBuffers.set('other', otherBuf);
        this.stemBuffers.set('vocals', vocalsBuf);
        this.trackDuration = durationSec;
        this.playbackOffset = 0;
        this.loopEnabled = true;
    }
    /**
     * Decode a user-supplied local audio file directly in the browser and split it into
     * 4 phase-aligned spectral bands using OfflineAudioContext so playback works even
     * when the Python Demucs backend is offline.
     */
    async loadLocalAudioFile(source) {
        if (!this.audioContext) {
            await this.initialize();
        }
        this.stop();
        const rawBytes = source instanceof ArrayBuffer ? source : await source.arrayBuffer();
        const decoded = await this.audioContext.decodeAudioData(rawBytes.slice(0));
        const sr = decoded.sampleRate;
        const len = decoded.length;
        const ch = Math.min(2, decoded.numberOfChannels);
        const renderBand = async (type, freq, q, secondFilter) => {
            const offline = new OfflineAudioContext(ch, len, sr);
            const src = offline.createBufferSource();
            src.buffer = decoded;
            const f1 = offline.createBiquadFilter();
            f1.type = type;
            f1.frequency.value = freq;
            f1.Q.value = q;
            src.connect(f1);
            if (secondFilter) {
                const f2 = offline.createBiquadFilter();
                f2.type = secondFilter.type;
                f2.frequency.value = secondFilter.freq;
                f2.Q.value = secondFilter.q;
                f1.connect(f2);
                f2.connect(offline.destination);
            }
            else {
                f1.connect(offline.destination);
            }
            src.start(0);
            return offline.startRendering();
        };
        const [bass, drums, other, vocals] = await Promise.all([
            renderBand('lowpass', 180, 0.707),
            renderBand('highpass', 180, 0.707, { type: 'lowpass', freq: 750, q: 0.707 }),
            renderBand('highpass', 750, 0.707, { type: 'lowpass', freq: 3200, q: 0.707 }),
            renderBand('highpass', 3200, 0.707)
        ]);
        this.stemBuffers.clear();
        this.stemBuffers.set('bass', bass);
        this.stemBuffers.set('drums', drums);
        this.stemBuffers.set('other', other);
        this.stemBuffers.set('vocals', vocals);
        this.loopEnabled = false;
        this.playbackOffset = 0;
        this.recalculateDuration();
    }
    /**
     * Synchronized Start Transport across all four stems using AudioContext.currentTime lookahead.
     */
    async play(offsetSec, delaySec = 0.05) {
        if (!this.audioContext || !this.workletNode) {
            await this.initialize();
        }
        this.clearPendingTransport();
        if (this.audioContext.state === 'suspended') {
            await this.audioContext.resume();
        }
        if (this.isPlaying) {
            this.stopSourceNodes();
        }
        const scheduleLookahead = Math.max(0.01, delaySec);
        const startTime = this.audioContext.currentTime + scheduleLookahead;
        const requestedOffset = offsetSec !== undefined ? offsetSec : this.playbackOffset;
        const clampedOffset = this.trackDuration > 0
            ? Math.max(0, Math.min(requestedOffset, Math.max(0, this.trackDuration - 0.01)))
            : Math.max(0, requestedOffset);
        const gen = ++this.playbackGeneration;
        let attachedEndHandler = false;
        for (const stem of STEM_NAMES) {
            const buffer = this.stemBuffers.get(stem);
            if (!buffer)
                continue;
            const sourceNode = this.audioContext.createBufferSource();
            sourceNode.buffer = buffer;
            sourceNode.loop = this.loopEnabled;
            const gainNode = this.stemGainNodes.get(stem);
            if (gainNode) {
                sourceNode.connect(gainNode);
            }
            if (!attachedEndHandler && !this.loopEnabled) {
                attachedEndHandler = true;
                sourceNode.onended = () => {
                    if (this.playbackGeneration === gen && this.isPlaying) {
                        this.isPlaying = false;
                        this.playbackOffset = 0;
                        this.stemSourceNodes.clear();
                        this.onPlaybackEnded?.();
                    }
                };
            }
            sourceNode.start(startTime, clampedOffset);
            this.stemSourceNodes.set(stem, sourceNode);
        }
        this.playbackStartTime = startTime - clampedOffset;
        this.playbackOffset = clampedOffset;
        this.isPlaying = true;
    }
    /**
     * Execute a network-synchronized transport command at a future hardware clock offset.
     */
    async scheduleTransport(action, delaySec, audioOffsetSec) {
        this.clearPendingTransport();
        const safeDelay = Math.max(0, delaySec);
        if (action === 'PLAY') {
            await this.play(audioOffsetSec, Math.max(0.01, safeDelay));
            return;
        }
        if (action === 'SEEK') {
            const wasPlaying = this.isPlaying;
            this.stopSourceNodes();
            this.resetAllSources();
            this.isPlaying = false;
            this.playbackOffset = Math.max(0, Math.min(audioOffsetSec, this.trackDuration || audioOffsetSec));
            if (wasPlaying) {
                await this.play(this.playbackOffset, Math.max(0.01, safeDelay));
            }
            return;
        }
        if (safeDelay <= 0.005) {
            if (action === 'PAUSE') {
                this.playbackOffset = audioOffsetSec;
                this.stopSourceNodes();
                this.isPlaying = false;
            }
            else {
                this.stop();
            }
            return;
        }
        this.pendingTransportTimer = setTimeout(() => {
            this.pendingTransportTimer = null;
            if (action === 'PAUSE') {
                this.playbackOffset = audioOffsetSec;
                this.stopSourceNodes();
                this.isPlaying = false;
            }
            else {
                this.stop();
            }
        }, Math.round(safeDelay * 1000));
    }
    pause() {
        this.clearPendingTransport();
        if (!this.isPlaying || !this.audioContext)
            return;
        this.playbackOffset = this.getCurrentTime();
        this.stopSourceNodes();
        this.isPlaying = false;
    }
    stop() {
        this.clearPendingTransport();
        this.stopSourceNodes();
        this.resetAllSources();
        this.playbackOffset = 0;
        this.isPlaying = false;
    }
    async seek(targetSeconds) {
        const wasPlaying = this.isPlaying;
        this.clearPendingTransport();
        if (wasPlaying) {
            this.stopSourceNodes();
            this.isPlaying = false;
        }
        this.resetAllSources();
        this.playbackOffset = Math.max(0, Math.min(targetSeconds, this.trackDuration || targetSeconds));
        if (wasPlaying) {
            await this.play(this.playbackOffset);
        }
    }
    setStemPosition(stemName, x, y, z) {
        const sourceId = STEM_INDEX_MAP[stemName];
        this.stemPositions.set(stemName, { x, y, z });
        if (this.workletNode) {
            const msg = {
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
    setStemVolume(stemName, volume) {
        const clamped = Math.max(0, volume);
        this.stemVolumes.set(stemName, clamped);
        const gainNode = this.stemGainNodes.get(stemName);
        if (gainNode && this.audioContext) {
            gainNode.gain.setTargetAtTime(clamped, this.audioContext.currentTime, 0.02);
        }
    }
    setMasterVolume(volume) {
        if (this.masterGainNode && this.audioContext) {
            this.masterGainNode.gain.setTargetAtTime(Math.max(0, volume), this.audioContext.currentTime, 0.02);
        }
    }
    setLoop(loop) {
        this.loopEnabled = loop;
        for (const node of this.stemSourceNodes.values()) {
            node.loop = loop;
        }
    }
    resetAllSources() {
        if (this.workletNode) {
            this.workletNode.port.postMessage({ type: 'RESET_ALL' });
        }
        this.kPowerRing.fill(0);
        this.kPowerWriteIdx = 0;
        this.kPowerCount = 0;
    }
    /**
     * Real-time per-stem level meters (0..1), zero GC during polling.
     */
    getStemLevels() {
        const levels = { bass: 0.02, drums: 0.02, other: 0.02, vocals: 0.02 };
        if (!this.isPlaying) {
            return levels;
        }
        const scratch = this.stemScratch;
        const len = scratch.length;
        for (const stem of STEM_NAMES) {
            const analyser = this.stemAnalyserNodes.get(stem);
            if (!analyser)
                continue;
            analyser.getFloatTimeDomainData(scratch);
            let sumSq = 0;
            for (let i = 0; i < len; ++i) {
                const v = scratch[i];
                sumSq += v * v;
            }
            const rms = Math.sqrt(sumSq / len);
            const db = rms > 1e-6 ? 20 * Math.log10(rms) : -60;
            // Map [-52 dBFS, -4 dBFS] -> [0.02, 1.0]
            levels[stem] = Math.max(0.02, Math.min(1.0, (db + 52) / 48));
        }
        return levels;
    }
    /**
     * Calculate real-time master output loudness:
     * - ITU-R BS.1770-4 K-weighted 3-second Short-Term LUFS when sidechain filters exist
     * - True stereo Peak dBFS and clipping detection
     */
    getMasterLoudness() {
        if (!this.analyserNode || !this.audioContext) {
            return { rmsDbfs: -60, peakDbfs: -60, sampleRate: 48000, isClipping: false };
        }
        const bufL = this.timeDomainScratch;
        const bufR = this.timeDomainScratchR;
        const len = bufL.length;
        let peak = 0.0;
        if (this.leftPeakAnalyser && this.rightPeakAnalyser) {
            this.leftPeakAnalyser.getFloatTimeDomainData(bufL);
            this.rightPeakAnalyser.getFloatTimeDomainData(bufR);
            for (let i = 0; i < len; ++i) {
                const aL = Math.abs(bufL[i]);
                const aR = Math.abs(bufR[i]);
                if (aL > peak)
                    peak = aL;
                if (aR > peak)
                    peak = aR;
            }
        }
        else {
            this.analyserNode.getFloatTimeDomainData(bufL);
            for (let i = 0; i < len; ++i) {
                const a = Math.abs(bufL[i]);
                if (a > peak)
                    peak = a;
            }
        }
        let loudnessLufs = -60.0;
        if (this.kLeftAnalyser && this.kRightAnalyser) {
            this.kLeftAnalyser.getFloatTimeDomainData(bufL);
            this.kRightAnalyser.getFloatTimeDomainData(bufR);
            let sumL = 0;
            let sumR = 0;
            for (let i = 0; i < len; ++i) {
                sumL += bufL[i] * bufL[i];
                sumR += bufR[i] * bufR[i];
            }
            const instPower = (sumL + sumR) / len;
            this.kPowerRing[this.kPowerWriteIdx] = instPower;
            this.kPowerWriteIdx = (this.kPowerWriteIdx + 1) % SHORT_TERM_RING_LEN;
            if (this.kPowerCount < SHORT_TERM_RING_LEN)
                this.kPowerCount++;
            let avgPower = 0;
            for (let i = 0; i < this.kPowerCount; ++i) {
                avgPower += this.kPowerRing[i];
            }
            avgPower /= Math.max(1, this.kPowerCount);
            loudnessLufs = avgPower > 1e-8 ? -0.691 + 10.0 * Math.log10(avgPower) : -60.0;
        }
        else {
            this.analyserNode.getFloatTimeDomainData(bufL);
            let sumSq = 0;
            for (let i = 0; i < len; ++i)
                sumSq += bufL[i] * bufL[i];
            const rms = Math.sqrt(sumSq / len);
            loudnessLufs = rms > 1e-6 ? 20.0 * Math.log10(rms) : -60.0;
        }
        const peakDbfs = peak > 1e-6 ? 20.0 * Math.log10(peak) : -60.0;
        return {
            rmsDbfs: Math.round(loudnessLufs * 10) / 10,
            peakDbfs: Math.round(peakDbfs * 10) / 10,
            sampleRate: this.audioContext.sampleRate,
            isClipping: peak >= 0.999
        };
    }
    getCurrentTime() {
        if (!this.isPlaying || !this.audioContext) {
            return this.playbackOffset;
        }
        const elapsed = Math.max(0, this.audioContext.currentTime - this.playbackStartTime);
        if (this.loopEnabled && this.trackDuration > 0) {
            return elapsed % this.trackDuration;
        }
        return this.trackDuration > 0 ? Math.min(elapsed, this.trackDuration) : elapsed;
    }
    getDuration() {
        return this.trackDuration;
    }
    getIsPlaying() {
        return this.isPlaying;
    }
    getDspBackend() {
        return this.dspBackend;
    }
    getSampleRate() {
        return this.audioContext ? this.audioContext.sampleRate : this.targetSampleRate;
    }
    hasStemsLoaded() {
        return this.stemBuffers.size > 0;
    }
    getStemPosition(stemName) {
        return this.stemPositions.get(stemName);
    }
    async dispose() {
        this.stop();
        if (this.audioContext && this.audioContext.state !== 'closed') {
            await this.audioContext.close();
        }
        this.audioContext = null;
        this.workletNode = null;
        this.masterGainNode = null;
        this.analyserNode = null;
        this.leftPeakAnalyser = null;
        this.rightPeakAnalyser = null;
        this.kLeftAnalyser = null;
        this.kRightAnalyser = null;
        this.stemGainNodes.clear();
        this.stemAnalyserNodes.clear();
    }
    recalculateDuration() {
        let maxDur = 0;
        for (const buf of this.stemBuffers.values()) {
            if (buf.duration > maxDur)
                maxDur = buf.duration;
        }
        this.trackDuration = maxDur;
    }
    clearPendingTransport() {
        if (this.pendingTransportTimer !== null) {
            clearTimeout(this.pendingTransportTimer);
            this.pendingTransportTimer = null;
        }
    }
    stopSourceNodes() {
        this.playbackGeneration++;
        for (const [, node] of this.stemSourceNodes.entries()) {
            try {
                node.onended = null;
                node.stop();
                node.disconnect();
            }
            catch {
                // Ignore if already stopped
            }
        }
        this.stemSourceNodes.clear();
    }
    async resampleHrirData(hrir, targetSr) {
        const sourceSr = 48000;
        const ratio = targetSr / sourceSr;
        const newFilterLen = Math.round(hrir.filterLen * ratio);
        const newTotalFloats = hrir.numPositions * newFilterLen;
        const resampledLeft = new Float32Array(newTotalFloats);
        const resampledRight = new Float32Array(newTotalFloats);
        for (let p = 0; p < hrir.numPositions; ++p) {
            const offlineCtx = new OfflineAudioContext(2, newFilterLen, targetSr);
            const srcBuffer = offlineCtx.createBuffer(2, hrir.filterLen, sourceSr);
            const leftSlice = hrir.leftHrir.subarray(p * hrir.filterLen, (p + 1) * hrir.filterLen);
            const rightSlice = hrir.rightHrir.subarray(p * hrir.filterLen, (p + 1) * hrir.filterLen);
            srcBuffer.copyToChannel(new Float32Array(leftSlice), 0);
            srcBuffer.copyToChannel(new Float32Array(rightSlice), 1);
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
