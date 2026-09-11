import {
  STEM_NAMES,
  STEM_INDEX_MAP
} from "./types.js";
class SpatialAudioEngine {
  audioContext = null;
  workletNode = null;
  masterGainNode = null;
  analyserNode = null;
  targetSampleRate;
  wasmUrl;
  workletUrl;
  hrirData;
  onSampleRateMismatch;
  onError;
  // Stem buffers and active graph nodes
  stemBuffers = /* @__PURE__ */ new Map();
  stemSourceNodes = /* @__PURE__ */ new Map();
  stemGainNodes = /* @__PURE__ */ new Map();
  stemPositions = /* @__PURE__ */ new Map();
  // Transport state
  isPlaying = false;
  playbackStartTime = 0;
  playbackOffset = 0;
  trackDuration = 0;
  // Scratchpad for master loudness telemetry (zero GC during polling)
  timeDomainScratch = new Float32Array(2048);
  constructor(options = {}) {
    this.targetSampleRate = options.targetSampleRate || 48e3;
    this.wasmUrl = options.wasmUrl || "/build/aurastream_standalone.wasm";
    this.workletUrl = options.workletUrl || "/web/SpatialWorkletProcessor.js";
    this.hrirData = options.hrirData;
    this.onSampleRateMismatch = options.onSampleRateMismatch;
    this.onError = options.onError;
    this.stemPositions.set("drums", { x: -1, y: 1.5, z: 0 });
    this.stemPositions.set("bass", { x: 0, y: 1, z: -0.5 });
    this.stemPositions.set("vocals", { x: 0, y: 2, z: 0.3 });
    this.stemPositions.set("other", { x: 1.2, y: 1.5, z: 0.2 });
  }
  /**
   * @brief Initialize AudioContext and register AudioWorkletProcessor.
   * Manages hardware sample-rate mismatch and pre-compiles Wasm module.
   */
  async initialize() {
    if (this.audioContext && this.workletNode) {
      return;
    }
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.audioContext = new AudioCtx({
        sampleRate: this.targetSampleRate,
        latencyHint: "interactive"
      });
    } catch (err) {
      console.warn("[SpatialAudioEngine] Browser rejected custom sampleRate; creating default context.");
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
      if (this.hrirData) {
        this.hrirData = await this.resampleHrirData(this.hrirData, actualSr);
      }
    }
    try {
      await this.audioContext.audioWorklet.addModule(this.workletUrl);
    } catch (err) {
      const error = new Error(`Failed to load AudioWorklet module from ${this.workletUrl}: ${err}`);
      if (this.onError) this.onError(error);
      throw error;
    }
    let wasmModule;
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
    this.workletNode = new AudioWorkletNode(this.audioContext, "spatial-worklet-processor", {
      numberOfInputs: 4,
      numberOfOutputs: 1,
      outputChannelCount: [2]
    });
    this.masterGainNode = this.audioContext.createGain();
    this.analyserNode = this.audioContext.createAnalyser();
    this.analyserNode.fftSize = 2048;
    this.workletNode.connect(this.masterGainNode);
    this.masterGainNode.connect(this.analyserNode);
    this.analyserNode.connect(this.audioContext.destination);
    for (let i = 0; i < STEM_NAMES.length; ++i) {
      const stem = STEM_NAMES[i];
      const gain = this.audioContext.createGain();
      gain.gain.value = 1;
      gain.connect(this.workletNode, 0, i);
      this.stemGainNodes.set(stem, gain);
    }
    const initMessage = {
      type: "INIT_WASM",
      wasmModule,
      hrirData: this.hrirData,
      sampleRate: actualSr
    };
    this.workletNode.port.postMessage(initMessage);
    for (const [stem, pos] of this.stemPositions.entries()) {
      this.setStemPosition(stem, pos.x, pos.y, pos.z);
    }
    console.info("[SpatialAudioEngine] Initialized successfully at", actualSr, "Hz");
  }
  /**
   * @brief Load and decode an audio stem from URL or ArrayBuffer.
   */
  async loadStem(stemName, source) {
    if (!this.audioContext) {
      await this.initialize();
    }
    let arrayBuffer;
    if (typeof source === "string") {
      const res = await fetch(source);
      if (!res.ok) throw new Error(`Failed to fetch stem ${stemName} from ${source}`);
      arrayBuffer = await res.arrayBuffer();
    } else {
      arrayBuffer = source;
    }
    const decodedBuffer = await this.audioContext.decodeAudioData(arrayBuffer.slice(0));
    this.stemBuffers.set(stemName, decodedBuffer);
    if (decodedBuffer.duration > this.trackDuration) {
      this.trackDuration = decodedBuffer.duration;
    }
    console.info(`[SpatialAudioEngine] Loaded stem '${stemName}': ${decodedBuffer.duration.toFixed(2)}s`);
  }
  /**
   * @brief Load all 4 stems simultaneously from dictionary of URLs.
   */
  async loadAllStems(stems) {
    const promises = Object.entries(stems).map(
      ([name, url]) => this.loadStem(name, url)
    );
    await Promise.all(promises);
  }
  /**
   * @brief Synchronized Start Transport across all four stems using currentTime scheduling.
   */
  async play(offsetSec = 0) {
    if (!this.audioContext || !this.workletNode) {
      await this.initialize();
    }
    if (this.isPlaying) return;
    if (this.audioContext.state === "suspended") {
      await this.audioContext.resume();
    }
    const scheduleLookahead = 0.05;
    const startTime = this.audioContext.currentTime + scheduleLookahead;
    const actualOffset = Math.max(0, offsetSec || this.playbackOffset);
    for (const stem of STEM_NAMES) {
      const buffer = this.stemBuffers.get(stem);
      if (!buffer) continue;
      const sourceNode = this.audioContext.createBufferSource();
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
  pause() {
    if (!this.isPlaying || !this.audioContext) return;
    this.playbackOffset = this.getCurrentTime();
    this.stopSourceNodes();
    this.isPlaying = false;
  }
  /**
   * @brief Stop playback and reset playhead to beginning.
   */
  stop() {
    this.stopSourceNodes();
    this.playbackOffset = 0;
    this.isPlaying = false;
  }
  /**
   * @brief Seek to a specific timestamp in seconds.
   */
  async seek(targetSeconds) {
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
  setStemPosition(stemName, x, y, z) {
    const sourceId = STEM_INDEX_MAP[stemName];
    this.stemPositions.set(stemName, { x, y, z });
    if (this.workletNode) {
      const msg = {
        type: "SET_POSITION",
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
  setStemVolume(stemName, volume) {
    const gainNode = this.stemGainNodes.get(stemName);
    if (gainNode && this.audioContext) {
      gainNode.gain.setTargetAtTime(Math.max(0, volume), this.audioContext.currentTime, 0.02);
    }
  }
  /**
   * @brief Set master output volume.
   */
  setMasterVolume(volume) {
    if (this.masterGainNode && this.audioContext) {
      this.masterGainNode.gain.setTargetAtTime(Math.max(0, volume), this.audioContext.currentTime, 0.02);
    }
  }
  /**
   * @brief Calculate real-time master output loudness (RMS and Peak dBFS).
   */
  getMasterLoudness() {
    if (!this.analyserNode || !this.audioContext) {
      return { rmsDbfs: -120, peakDbfs: -120, sampleRate: 48e3, isClipping: false };
    }
    this.analyserNode.getFloatTimeDomainData(this.timeDomainScratch);
    const len = this.timeDomainScratch.length;
    let sumSquares = 0;
    let peak = 0;
    for (let i = 0; i < len; ++i) {
      const val = this.timeDomainScratch[i];
      const absVal = Math.abs(val);
      if (absVal > peak) peak = absVal;
      sumSquares += val * val;
    }
    const rms = Math.sqrt(sumSquares / len);
    const rmsDbfs = rms > 1e-6 ? 20 * Math.log10(rms) : -120;
    const peakDbfs = peak > 1e-6 ? 20 * Math.log10(peak) : -120;
    return {
      rmsDbfs: Math.round(rmsDbfs * 10) / 10,
      peakDbfs: Math.round(peakDbfs * 10) / 10,
      sampleRate: this.audioContext.sampleRate,
      isClipping: peak >= 0.999
    };
  }
  getCurrentTime() {
    if (!this.isPlaying || !this.audioContext) {
      return this.playbackOffset;
    }
    return this.audioContext.currentTime - this.playbackStartTime;
  }
  getDuration() {
    return this.trackDuration;
  }
  getStemPosition(stemName) {
    return this.stemPositions.get(stemName);
  }
  stopSourceNodes() {
    for (const [stem, node] of this.stemSourceNodes.entries()) {
      try {
        node.stop();
        node.disconnect();
      } catch (err) {
      }
    }
    this.stemSourceNodes.clear();
  }
  /**
   * @brief In-memory OfflineAudioContext resampler for HRIR arrays when hardware sample rate mismatches.
   */
  async resampleHrirData(hrir, targetSr) {
    const sourceSr = 48e3;
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
export {
  SpatialAudioEngine
};
