/**
 * AuraStream SpatialWorkletProcessor
 * High-performance real-time AudioWorkletProcessor running on the browser audio thread.
 *
 * Strict Real-Time Audio Constraints:
 * - ZERO dynamic memory allocations in process()
 * - Pre-allocated typed array views and fixed linear WebAssembly.Memory mappings
 * - 4-stem inputs (drums, bass, vocals, other) to 1 stereo binaural output
 * - Supports both compiled C++ WebAssembly (INIT_WASM) and a bit-compatible
 *   zero-allocation 1024-point FFT Fast Overlap-Add DSP fallback (INIT_JS_DSP)
 * - Lock-free parameter updates via postMessage
 */

const BLOCK_SIZE = 128;
const HRIR_FILTER_LEN = 512;
const FFT_LEN = 1024;
const LOG2_FFT = 10;
const HALF_FFT = FFT_LEN >> 1;
const OVERLAP_SIZE = HRIR_FILTER_LEN;
const NUM_SOURCES = 4; // 0: drums, 1: bass, 2: vocals, 3: other
const MIN_DISTANCE_M = 0.5;
const REF_DISTANCE_M = 1.0;

/**
 * Synthesizes a physically grounded 72-position horizontal 512-tap HRIR dataset
 * matching BinauralConvolver.cpp's azimuth table:
 *   az(p) = -PI + (2 * PI * p / 72), 0 = front (+Y), +PI/2 = right (+X).
 *
 * Encodes:
 * - Woodworth-Schlosberg interaural time difference (fractional-delay windowed sinc)
 * - Head-shadow frequency-dependent ILD low-pass filtering on the contralateral ear
 * - Subtle front/back pinna spectral cue so +Y and -Y are perceptually distinct
 */
function synthesizePhysicalHrirTable(sampleRate) {
    const sr = sampleRate || 48000;
    const numPositions = 72;
    const filterLen = HRIR_FILTER_LEN;
    const leftHrir = new Float32Array(numPositions * filterLen);
    const rightHrir = new Float32Array(numPositions * filterLen);

    const headRadiusM = 0.0875;
    const speedOfSound = 343.0;
    const baseDelaySamples = 40.0;
    const sincHalfWidth = 16;

    const writeEarFilter = (target, offset, delaySamples, gain, cutoffHz, rearAmount) => {
        const center = Math.floor(delaySamples);
        const start = Math.max(0, center - sincHalfWidth);
        const end = Math.min(filterLen - 1, center + sincHalfWidth);

        // 1. Fractional-delay Hann-windowed sinc impulse
        let sum = 0;
        for (let n = start; n <= end; ++n) {
            const x = n - delaySamples;
            const sinc = Math.abs(x) < 1e-6 ? 1.0 : Math.sin(Math.PI * x) / (Math.PI * x);
            const winPos = (n - (delaySamples - sincHalfWidth)) / (2 * sincHalfWidth);
            const hann = (winPos >= 0 && winPos <= 1) ? 0.5 * (1.0 - Math.cos(2.0 * Math.PI * winPos)) : 0.0;
            const val = sinc * hann;
            target[offset + n] = val;
            sum += val;
        }
        const invSum = sum > 1e-6 ? gain / sum : gain;
        for (let n = start; n <= end; ++n) {
            target[offset + n] *= invSum;
        }

        // 2. Subtle pinna notch / reflection cue differentiating front vs rear
        const notchDelay = Math.max(2, Math.round(0.00018 * sr));
        const notchWeight = rearAmount > 0 ? -0.14 * rearAmount : 0.06 * (-rearAmount);
        for (let n = filterLen - 1; n >= notchDelay; --n) {
            target[offset + n] += notchWeight * target[offset + n - notchDelay];
        }

        // 3. One-pole head-shadow low-pass filter (causal, decays cleanly within < 120 taps)
        const clampedCutoff = Math.max(800, Math.min(sr * 0.45, cutoffHz));
        const pole = Math.exp((-2.0 * Math.PI * clampedCutoff) / sr);
        const b0 = 1.0 - pole;
        let prev = 0.0;
        for (let n = 0; n < filterLen; ++n) {
            const y = b0 * target[offset + n] + pole * prev;
            target[offset + n] = y;
            prev = y;
        }
    };

    for (let p = 0; p < numPositions; ++p) {
        const az = -Math.PI + (2.0 * Math.PI * p) / numPositions;
        const sinAz = Math.sin(az); // +1 at right, -1 at left
        const cosAz = Math.cos(az); // +1 at front, -1 at behind
        const lateral = Math.asin(Math.max(-1, Math.min(1, sinAz)));
        const absLat = Math.abs(lateral);

        // Woodworth-Schlosberg ITD in samples
        const itdSamples = (headRadiusM / speedOfSound) * (Math.sin(absLat) + absLat) * sr;
        const rearAmount = Math.max(0, -cosAz); // 0 in front hemisphere, 1 directly behind
        const frontBackScalar = -cosAz; // -1 front, +1 rear

        // Contralateral shadow factor: 0 when straight ahead/behind, 1 at hard lateral
        const shadow = Math.abs(sinAz);
        const ipsiGain = 1.0 + 0.08 * shadow;
        const contraGain = 1.0 - 0.58 * shadow;

        const baseCutoff = 18500 - 6500 * rearAmount;
        const ipsiCutoff = baseCutoff;
        const contraCutoff = Math.max(1350, baseCutoff * (1.0 - 0.88 * Math.pow(shadow, 1.15)));

        const offset = p * filterLen;
        if (sinAz >= 0) {
            // Source on Right (+X): right ear is ipsilateral, left ear delayed & shadowed
            writeEarFilter(rightHrir, offset, baseDelaySamples, ipsiGain, ipsiCutoff, frontBackScalar);
            writeEarFilter(leftHrir, offset, baseDelaySamples + itdSamples, contraGain, contraCutoff, frontBackScalar);
        } else {
            // Source on Left (-X): left ear is ipsilateral, right ear delayed & shadowed
            writeEarFilter(leftHrir, offset, baseDelaySamples, ipsiGain, ipsiCutoff, frontBackScalar);
            writeEarFilter(rightHrir, offset, baseDelaySamples + itdSamples, contraGain, contraCutoff, frontBackScalar);
        }
    }

    return { leftHrir, rightHrir, numPositions, filterLen };
}

/**
 * Zero-allocation 1024-point FFT Fast Overlap-Add Binaural Convolver.
 * Architectural mirror of src/BinauralConvolver.cpp for environments where
 * Emscripten Wasm compilation has not yet been run.
 *
 * All typed arrays are allocated once during construction / loadHrirTable().
 * processBlock() allocates ZERO objects or arrays.
 */
class JsBinauralConvolver {
    constructor(sampleRate) {
        this.sampleRate = sampleRate || 48000;
        this.numPositions = 0;

        // 1. Precompute 1024-point bit-reversal and twiddle tables
        this.bitRev = new Uint16Array(FFT_LEN);
        for (let i = 0; i < FFT_LEN; ++i) {
            let rev = 0;
            let val = i;
            for (let j = 0; j < LOG2_FFT; ++j) {
                rev = (rev << 1) | (val & 1);
                val >>= 1;
            }
            this.bitRev[i] = rev;
        }

        this.twiddleCos = new Float32Array(HALF_FFT);
        this.twiddleSin = new Float32Array(HALF_FFT);
        for (let k = 0; k < HALF_FFT; ++k) {
            const angle = (-2.0 * Math.PI * k) / FFT_LEN;
            this.twiddleCos[k] = Math.cos(angle);
            this.twiddleSin[k] = Math.sin(angle);
        }

        // 2. Per-source flat state arrays (zero GC)
        this.activeIdx = new Int32Array(NUM_SOURCES);
        this.targetIdx = new Int32Array(NUM_SOURCES);
        this.isCrossfading = new Uint8Array(NUM_SOURCES);
        this.isActive = new Uint8Array(NUM_SOURCES);
        this.currentGain = new Float32Array(NUM_SOURCES).fill(1.0);
        this.targetGain = new Float32Array(NUM_SOURCES).fill(1.0);
        this.targetElev = new Float32Array(NUM_SOURCES);
        this.elevStateL = new Float32Array(NUM_SOURCES);
        this.elevStateR = new Float32Array(NUM_SOURCES);
        this.overlapL = new Float32Array(NUM_SOURCES * OVERLAP_SIZE);
        this.overlapR = new Float32Array(NUM_SOURCES * OVERLAP_SIZE);

        // 3. Pre-allocated FFT & OLA scratch buffers
        this.scratchRe = new Float32Array(FFT_LEN);
        this.scratchIm = new Float32Array(FFT_LEN);
        this.inSpecRe = new Float32Array(FFT_LEN);
        this.inSpecIm = new Float32Array(FFT_LEN);
        this.timeCurrL = new Float32Array(FFT_LEN);
        this.timeCurrR = new Float32Array(FFT_LEN);
        this.timeTargL = new Float32Array(FFT_LEN);
        this.timeTargR = new Float32Array(FFT_LEN);

        // 4. HRIR frequency-domain tables (initialized by loadHrirTable)
        this.dirX = new Float32Array(0);
        this.dirY = new Float32Array(0);
        this.dirZ = new Float32Array(0);
        this.specLRe = new Float32Array(0);
        this.specLIm = new Float32Array(0);
        this.specRRe = new Float32Array(0);
        this.specRIm = new Float32Array(0);
    }

    transform(re, im, inverse) {
        for (let s = 1; s <= LOG2_FFT; ++s) {
            const m = 1 << s;
            const m2 = m >> 1;
            const step = FFT_LEN / m;

            for (let j = 0; j < m2; ++j) {
                const twIdx = j * step;
                const wr = this.twiddleCos[twIdx];
                const wi = inverse ? -this.twiddleSin[twIdx] : this.twiddleSin[twIdx];

                for (let k = 0; k < FFT_LEN; k += m) {
                    const idxA = k + j;
                    const idxB = idxA + m2;
                    const br = re[idxB];
                    const bi = im[idxB];
                    const tr = wr * br - wi * bi;
                    const ti = wr * bi + wi * br;
                    const ar = re[idxA];
                    const ai = im[idxA];

                    re[idxA] = ar + tr;
                    im[idxA] = ai + ti;
                    re[idxB] = ar - tr;
                    im[idxB] = ai - ti;
                }
            }
        }

        if (inverse) {
            const norm = 1.0 / FFT_LEN;
            for (let i = 0; i < FFT_LEN; ++i) {
                re[i] *= norm;
                im[i] *= norm;
            }
        }
    }

    forwardReal(input, inputLen, outRe, outIm) {
        const rev = this.bitRev;
        const sRe = this.scratchRe;
        const sIm = this.scratchIm;

        for (let i = 0; i < FFT_LEN; ++i) {
            const r = rev[i];
            sRe[r] = i < inputLen ? input[i] : 0.0;
            sIm[r] = 0.0;
        }
        this.transform(sRe, sIm, false);
        outRe.set(sRe);
        outIm.set(sIm);
    }

    convolveToTime(inRe, inIm, hRe, hIm, hOffset, outTime) {
        const rev = this.bitRev;
        const sRe = this.scratchRe;
        const sIm = this.scratchIm;

        for (let k = 0; k < FFT_LEN; ++k) {
            const ar = inRe[k];
            const ai = inIm[k];
            const br = hRe[hOffset + k];
            const bi = hIm[hOffset + k];
            const r = rev[k];
            sRe[r] = ar * br - ai * bi;
            sIm[r] = ar * bi + ai * br;
        }

        this.transform(sRe, sIm, true);
        outTime.set(sRe);
    }

    loadHrirTable(hrirData) {
        const numPositions = hrirData.numPositions;
        const filterLen = Math.min(hrirData.filterLen, HRIR_FILTER_LEN);
        this.numPositions = numPositions;

        this.dirX = new Float32Array(numPositions);
        this.dirY = new Float32Array(numPositions);
        this.dirZ = new Float32Array(numPositions);
        this.specLRe = new Float32Array(numPositions * FFT_LEN);
        this.specLIm = new Float32Array(numPositions * FFT_LEN);
        this.specRRe = new Float32Array(numPositions * FFT_LEN);
        this.specRIm = new Float32Array(numPositions * FFT_LEN);

        const tempFilter = new Float32Array(FFT_LEN);
        const tempRe = new Float32Array(FFT_LEN);
        const tempIm = new Float32Array(FFT_LEN);

        for (let p = 0; p < numPositions; ++p) {
            if (numPositions <= 72) {
                const az = -Math.PI + (2.0 * Math.PI * p) / numPositions;
                this.dirX[p] = Math.sin(az);
                this.dirY[p] = Math.cos(az);
                this.dirZ[p] = 0.0;
            } else {
                const y = 1.0 - (2.0 * p + 1.0) / numPositions;
                const radius = Math.sqrt(Math.max(0.0, 1.0 - y * y));
                const phi = (2.0 * Math.PI * p) / 1.618033988749895;
                this.dirX[p] = radius * Math.cos(phi);
                this.dirY[p] = radius * Math.sin(phi);
                this.dirZ[p] = y;
            }

            const srcOffset = p * hrirData.filterLen;
            const dstOffset = p * FFT_LEN;

            tempFilter.fill(0);
            for (let n = 0; n < filterLen; ++n) tempFilter[n] = hrirData.leftHrir[srcOffset + n];
            this.forwardReal(tempFilter, filterLen, tempRe, tempIm);
            this.specLRe.set(tempRe, dstOffset);
            this.specLIm.set(tempIm, dstOffset);

            tempFilter.fill(0);
            for (let n = 0; n < filterLen; ++n) tempFilter[n] = hrirData.rightHrir[srcOffset + n];
            this.forwardReal(tempFilter, filterLen, tempRe, tempIm);
            this.specRRe.set(tempRe, dstOffset);
            this.specRIm.set(tempIm, dstOffset);
        }
    }

    findNearestIndex(dx, dy, dz) {
        if (this.numPositions <= 0) return 0;
        let bestIdx = 0;
        let bestSim = -2.0;
        const dirX = this.dirX;
        const dirY = this.dirY;
        const dirZ = this.dirZ;
        for (let p = 0; p < this.numPositions; ++p) {
            const sim = dx * dirX[p] + dy * dirY[p] + dz * dirZ[p];
            if (sim > bestSim) {
                bestSim = sim;
                bestIdx = p;
            }
        }
        return bestIdx;
    }

    setSourcePosition(id, x, y, z) {
        if (id < 0 || id >= NUM_SOURCES) return;
        const dist = Math.hypot(x, y, z);
        const az = Math.atan2(x, y);
        const el = dist > 1e-6 ? Math.asin(Math.max(-1, Math.min(1, z / dist))) : 0.0;
        const cosEl = Math.cos(el);
        const dx = Math.sin(az) * cosEl;
        const dy = Math.cos(az) * cosEl;
        const dz = Math.sin(el);

        this.targetGain[id] = REF_DISTANCE_M / Math.max(dist, MIN_DISTANCE_M);
        this.targetElev[id] = dz; // [-1, 1] elevation presence cue

        const target = this.findNearestIndex(dx, dy, dz);
        if (!this.isActive[id]) {
            this.activeIdx[id] = target;
            this.targetIdx[id] = target;
            this.currentGain[id] = this.targetGain[id];
            this.isCrossfading[id] = 0;
            this.isActive[id] = 1;
        } else if (target !== this.activeIdx[id]) {
            this.targetIdx[id] = target;
            this.isCrossfading[id] = 1;
        } else {
            this.targetIdx[id] = target;
            this.isCrossfading[id] = 0;
        }
    }

    resetSource(id) {
        if (id < 0 || id >= NUM_SOURCES) return;
        this.activeIdx[id] = 0;
        this.targetIdx[id] = 0;
        this.isCrossfading[id] = 0;
        this.isActive[id] = 0;
        this.currentGain[id] = 1.0;
        this.targetGain[id] = 1.0;
        this.targetElev[id] = 0.0;
        this.elevStateL[id] = 0.0;
        this.elevStateR[id] = 0.0;
        const base = id * OVERLAP_SIZE;
        this.overlapL.fill(0, base, base + OVERLAP_SIZE);
        this.overlapR.fill(0, base, base + OVERLAP_SIZE);
    }

    processBlock(id, inputBlock, outLeft, outRight) {
        if (this.numPositions <= 0 || id < 0 || id >= NUM_SOURCES) {
            outLeft.fill(0);
            outRight.fill(0);
            return;
        }

        // 1. Forward FFT of 128-sample zero-padded block
        this.forwardReal(inputBlock, BLOCK_SIZE, this.inSpecRe, this.inSpecIm);

        // 2. Convolve with active HRIR filter
        const actOff = this.activeIdx[id] * FFT_LEN;
        this.convolveToTime(this.inSpecRe, this.inSpecIm, this.specLRe, this.specLIm, actOff, this.timeCurrL);
        this.convolveToTime(this.inSpecRe, this.inSpecIm, this.specRRe, this.specRIm, actOff, this.timeCurrR);

        // 3. Optional dual-convolver cross-fade
        const crossfade = this.isCrossfading[id] && this.activeIdx[id] !== this.targetIdx[id];
        if (crossfade) {
            const targOff = this.targetIdx[id] * FFT_LEN;
            this.convolveToTime(this.inSpecRe, this.inSpecIm, this.specLRe, this.specLIm, targOff, this.timeTargL);
            this.convolveToTime(this.inSpecRe, this.inSpecIm, this.specRRe, this.specRIm, targOff, this.timeTargR);
        }

        // 4. Sample-accurate gain ramp + overlap-add synthesis + gentle elevation pinna tilt
        const invBlock = 1.0 / BLOCK_SIZE;
        const gainStart = this.currentGain[id];
        const gainStep = (this.targetGain[id] - gainStart) * invBlock;
        const ovBase = id * OVERLAP_SIZE;
        const ovL = this.overlapL;
        const ovR = this.overlapR;
        const currL = this.timeCurrL;
        const currR = this.timeCurrR;
        const elevTilt = this.targetElev[id] * 0.22; // gentle high-frequency elevation cue
        let lpL = this.elevStateL[id];
        let lpR = this.elevStateR[id];

        if (!crossfade) {
            for (let n = 0; n < BLOCK_SIZE; ++n) {
                const g = gainStart + n * gainStep;
                const rawL = (currL[n] + ovL[ovBase + n]) * g;
                const rawR = (currR[n] + ovR[ovBase + n]) * g;
                lpL += 0.35 * (rawL - lpL);
                lpR += 0.35 * (rawR - lpR);
                outLeft[n] = rawL + elevTilt * (rawL - lpL);
                outRight[n] = rawR + elevTilt * (rawR - lpR);
            }

            const tailKeep = OVERLAP_SIZE - BLOCK_SIZE;
            for (let n = 0; n < tailKeep; ++n) {
                ovL[ovBase + n] = ovL[ovBase + n + BLOCK_SIZE] + currL[n + BLOCK_SIZE];
                ovR[ovBase + n] = ovR[ovBase + n + BLOCK_SIZE] + currR[n + BLOCK_SIZE];
            }
            for (let n = tailKeep; n < OVERLAP_SIZE; ++n) {
                ovL[ovBase + n] = currL[n + BLOCK_SIZE];
                ovR[ovBase + n] = currR[n + BLOCK_SIZE];
            }
        } else {
            const targL = this.timeTargL;
            const targR = this.timeTargR;
            for (let n = 0; n < BLOCK_SIZE; ++n) {
                const alpha = (n + 1) * invBlock;
                const yL = (1.0 - alpha) * currL[n] + alpha * targL[n];
                const yR = (1.0 - alpha) * currR[n] + alpha * targR[n];
                const g = gainStart + n * gainStep;
                const rawL = (yL + ovL[ovBase + n]) * g;
                const rawR = (yR + ovR[ovBase + n]) * g;
                lpL += 0.35 * (rawL - lpL);
                lpR += 0.35 * (rawR - lpR);
                outLeft[n] = rawL + elevTilt * (rawL - lpL);
                outRight[n] = rawR + elevTilt * (rawR - lpR);
            }

            const tailKeep = OVERLAP_SIZE - BLOCK_SIZE;
            for (let n = 0; n < tailKeep; ++n) {
                ovL[ovBase + n] = ovL[ovBase + n + BLOCK_SIZE] + targL[n + BLOCK_SIZE];
                ovR[ovBase + n] = ovR[ovBase + n + BLOCK_SIZE] + targR[n + BLOCK_SIZE];
            }
            for (let n = tailKeep; n < OVERLAP_SIZE; ++n) {
                ovL[ovBase + n] = targL[n + BLOCK_SIZE];
                ovR[ovBase + n] = targR[n + BLOCK_SIZE];
            }

            this.activeIdx[id] = this.targetIdx[id];
            this.isCrossfading[id] = 0;
        }

        this.elevStateL[id] = lpL;
        this.elevStateR[id] = lpR;
        this.currentGain[id] = this.targetGain[id];
    }
}

class SpatialWorkletProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.BLOCK_SIZE = BLOCK_SIZE;
        this.NUM_SOURCES = NUM_SOURCES;

        this.mode = 'none'; // 'wasm' | 'worklet-dsp' | 'none'
        this.sampleRate = 48000;

        // Wasm backend state
        this.wasmInstance = null;
        this.wasmExports = null;
        this.wasmMemory = null;
        this.heapF32 = null;

        this.inPtrs = new Int32Array(this.NUM_SOURCES);
        this.inOffsets = new Int32Array(this.NUM_SOURCES);
        this.outLeftPtr = 0;
        this.outLeftOffset = 0;
        this.outRightPtr = 0;
        this.outRightOffset = 0;

        // Zero-allocation Worklet JS DSP fallback state
        this.jsConvolver = null;
        this.jsInputBuf = new Float32Array(this.BLOCK_SIZE);
        this.jsOutL = new Float32Array(this.BLOCK_SIZE);
        this.jsOutR = new Float32Array(this.BLOCK_SIZE);

        this.isReady = false;
        this.port.onmessage = this.handleMessage.bind(this);
    }

    async handleMessage(event) {
        const msg = event.data;
        if (!msg) return;

        if (msg.type === 'INIT_WASM') {
            try {
                await this.initializeWasm(msg.wasmModule, msg.hrirData, msg.sampleRate);
                this.port.postMessage({
                    type: 'ENGINE_INITIALIZED',
                    sampleRate: this.sampleRate,
                    blockSize: this.BLOCK_SIZE,
                    backend: 'wasm'
                });
            } catch (err) {
                this.port.postMessage({
                    type: 'ENGINE_ERROR',
                    error: err && err.message ? err.message : String(err)
                });
            }
        } else if (msg.type === 'INIT_JS_DSP') {
            try {
                this.initializeJsDsp(msg.hrirData, msg.sampleRate);
                this.port.postMessage({
                    type: 'ENGINE_INITIALIZED',
                    sampleRate: this.sampleRate,
                    blockSize: this.BLOCK_SIZE,
                    backend: 'worklet-dsp'
                });
            } catch (err) {
                this.port.postMessage({
                    type: 'ENGINE_ERROR',
                    error: err && err.message ? err.message : String(err)
                });
            }
        } else if (msg.type === 'SET_POSITION') {
            if (this.mode === 'wasm' && this.wasmExports && this.wasmExports.set_source_position) {
                this.wasmExports.set_source_position(msg.sourceId, msg.x, msg.y, msg.z);
            } else if (this.mode === 'worklet-dsp' && this.jsConvolver) {
                this.jsConvolver.setSourcePosition(msg.sourceId, msg.x, msg.y, msg.z);
            }
        } else if (msg.type === 'RESET_SOURCE') {
            if (this.mode === 'wasm' && this.wasmExports && this.wasmExports.reset_source) {
                this.wasmExports.reset_source(msg.sourceId);
            } else if (this.mode === 'worklet-dsp' && this.jsConvolver) {
                this.jsConvolver.resetSource(msg.sourceId);
            }
        } else if (msg.type === 'RESET_ALL') {
            for (let i = 0; i < this.NUM_SOURCES; ++i) {
                if (this.mode === 'wasm' && this.wasmExports && this.wasmExports.reset_source) {
                    this.wasmExports.reset_source(i);
                } else if (this.mode === 'worklet-dsp' && this.jsConvolver) {
                    this.jsConvolver.resetSource(i);
                }
            }
        }
    }

    initializeJsDsp(hrirData, sampleRate) {
        this.sampleRate = sampleRate || 48000;
        const convolver = new JsBinauralConvolver(this.sampleRate);
        const table = (hrirData && hrirData.numPositions > 0 && hrirData.filterLen > 0)
            ? hrirData
            : synthesizePhysicalHrirTable(this.sampleRate);
        convolver.loadHrirTable(table);
        this.jsConvolver = convolver;
        this.mode = 'worklet-dsp';
        this.isReady = true;
    }

    async initializeWasm(wasmModule, hrirData, sampleRate) {
        this.sampleRate = sampleRate || 48000;
        const initialPages = 256; // 16 MB
        const maximumPages = 1024; // 64 MB

        this.wasmMemory = new WebAssembly.Memory({
            initial: initialPages,
            maximum: maximumPages
        });

        const importObject = {
            env: {
                memory: this.wasmMemory,
                abort: (err) => console.error('[SpatialWorklet] Wasm Abort:', err),
                emscripten_notify_memory_growth: () => this.updateHeapViews()
            },
            wasi_snapshot_preview1: {
                proc_exit: () => {},
                fd_close: () => 0,
                fd_write: () => 0,
                fd_seek: () => 0
            }
        };

        let instantiated;
        if (wasmModule && (wasmModule instanceof WebAssembly.Module || typeof wasmModule === 'object')) {
            instantiated = await WebAssembly.instantiate(wasmModule, importObject);
        } else if (wasmModule instanceof ArrayBuffer || ArrayBuffer.isView(wasmModule)) {
            const compiled = await WebAssembly.compile(wasmModule);
            instantiated = await WebAssembly.instantiate(compiled, importObject);
        } else {
            throw new Error('Invalid WebAssembly module supplied to SpatialWorkletProcessor.');
        }

        this.wasmInstance = instantiated.instance ? instantiated.instance : instantiated;
        this.wasmExports = this.wasmInstance.exports;
        if (this.wasmExports.memory) {
            this.wasmMemory = this.wasmExports.memory;
        }

        if (this.wasmExports.init_engine) {
            this.wasmExports.init_engine(this.sampleRate);
        }

        const bytesPerBlock = this.BLOCK_SIZE * 4;
        const malloc = this.wasmExports.malloc;

        if (!malloc) {
            throw new Error('Exported malloc symbol not found in WebAssembly binary.');
        }

        for (let i = 0; i < this.NUM_SOURCES; ++i) {
            this.inPtrs[i] = malloc(bytesPerBlock);
            this.inOffsets[i] = this.inPtrs[i] >> 2;
        }

        this.outLeftPtr = malloc(bytesPerBlock);
        this.outLeftOffset = this.outLeftPtr >> 2;

        this.outRightPtr = malloc(bytesPerBlock);
        this.outRightOffset = this.outRightPtr >> 2;

        this.updateHeapViews();

        if (hrirData && hrirData.numPositions > 0 && hrirData.filterLen > 0) {
            this.loadHrirData(hrirData);
        } else {
            this.loadDefaultHrir();
        }

        this.mode = 'wasm';
        this.isReady = true;
    }

    updateHeapViews() {
        this.heapF32 = new Float32Array(this.wasmMemory.buffer);
    }

    loadHrirData(hrirData) {
        const totalFloats = hrirData.numPositions * hrirData.filterLen;
        const totalBytes = totalFloats * 4;
        const malloc = this.wasmExports.malloc;
        const free = this.wasmExports.free;

        const leftPtr = malloc(totalBytes);
        const rightPtr = malloc(totalBytes);

        this.updateHeapViews();
        this.heapF32.set(hrirData.leftHrir, leftPtr >> 2);
        this.heapF32.set(hrirData.rightHrir, rightPtr >> 2);

        this.wasmExports.load_hrir_table(
            leftPtr,
            rightPtr,
            hrirData.numPositions,
            hrirData.filterLen
        );

        if (free) {
            free(leftPtr);
            free(rightPtr);
        }
    }

    loadDefaultHrir() {
        this.loadHrirData(synthesizePhysicalHrirTable(this.sampleRate));
    }

    /**
     * Real-time audio rendering loop.
     * STRICT INVARIANT: ZERO dynamic allocations inside this callback.
     */
    process(inputs, outputs) {
        const output = outputs[0];
        if (!output || output.length < 2) return true;

        const outLeftChannel = output[0];
        const outRightChannel = output[1];

        outLeftChannel.fill(0);
        outRightChannel.fill(0);

        if (!this.isReady) {
            return true;
        }

        const activeInputCount = Math.min(inputs.length, this.NUM_SOURCES);

        if (this.mode === 'wasm') {
            if (this.heapF32.buffer !== this.wasmMemory.buffer) {
                this.updateHeapViews();
            }

            const heap = this.heapF32;
            const lOffset = this.outLeftOffset;
            const rOffset = this.outRightOffset;
            const processAudio = this.wasmExports.process_audio;

            for (let i = 0; i < activeInputCount; ++i) {
                const input = inputs[i];
                if (!input || input.length === 0) continue;

                const ch0 = input[0];
                if (!ch0 || ch0.length !== this.BLOCK_SIZE) continue;

                const inOff = this.inOffsets[i];
                if (input.length >= 2 && input[1] && input[1].length === this.BLOCK_SIZE) {
                    const ch1 = input[1];
                    for (let n = 0; n < this.BLOCK_SIZE; ++n) {
                        heap[inOff + n] = 0.5 * (ch0[n] + ch1[n]);
                    }
                } else {
                    heap.set(ch0, inOff);
                }

                processAudio(
                    i,
                    this.inPtrs[i],
                    this.outLeftPtr,
                    this.outRightPtr,
                    this.BLOCK_SIZE
                );

                for (let n = 0; n < this.BLOCK_SIZE; ++n) {
                    outLeftChannel[n] += heap[lOffset + n];
                    outRightChannel[n] += heap[rOffset + n];
                }
            }
            return true;
        }

        if (this.mode === 'worklet-dsp' && this.jsConvolver) {
            const convolver = this.jsConvolver;
            const inBuf = this.jsInputBuf;
            const tmpL = this.jsOutL;
            const tmpR = this.jsOutR;

            for (let i = 0; i < activeInputCount; ++i) {
                const input = inputs[i];
                if (!input || input.length === 0) continue;

                const ch0 = input[0];
                if (!ch0 || ch0.length !== this.BLOCK_SIZE) continue;

                if (input.length >= 2 && input[1] && input[1].length === this.BLOCK_SIZE) {
                    const ch1 = input[1];
                    for (let n = 0; n < this.BLOCK_SIZE; ++n) {
                        inBuf[n] = 0.5 * (ch0[n] + ch1[n]);
                    }
                } else {
                    inBuf.set(ch0);
                }

                convolver.processBlock(i, inBuf, tmpL, tmpR);

                for (let n = 0; n < this.BLOCK_SIZE; ++n) {
                    outLeftChannel[n] += tmpL[n];
                    outRightChannel[n] += tmpR[n];
                }
            }
        }

        return true;
    }
}

registerProcessor('spatial-worklet-processor', SpatialWorkletProcessor);
