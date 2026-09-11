/**
 * AuraStream SpatialWorkletProcessor
 * High-performance real-time AudioWorkletProcessor running on the browser audio thread.
 * 
 * Strict Real-Time Audio Constraints:
 * - ZERO dynamic memory allocations in process()
 * - Pre-allocated typed array views and fixed linear WebAssembly.Memory mappings
 * - 4-stem inputs (drums, bass, vocals, other) to 1 stereo binaural output
 * - Lock-free parameter updates via postMessage
 */

class SpatialWorkletProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.BLOCK_SIZE = 128;
        this.NUM_SOURCES = 4; // 0: drums, 1: bass, 2: vocals, 3: other

        this.wasmInstance = null;
        this.wasmExports = null;
        this.wasmMemory = null;
        this.heapF32 = null;

        // Pre-allocated pointer addresses in Wasm linear memory
        this.inPtrs = new Int32Array(this.NUM_SOURCES);
        this.inOffsets = new Int32Array(this.NUM_SOURCES); // byte_offset / 4
        this.outLeftPtr = 0;
        this.outLeftOffset = 0;
        this.outRightPtr = 0;
        this.outRightOffset = 0;

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
                    sampleRate: msg.sampleRate,
                    blockSize: this.BLOCK_SIZE
                });
            } catch (err) {
                this.port.postMessage({
                    type: 'ENGINE_ERROR',
                    error: err && err.message ? err.message : String(err)
                });
            }
        } else if (msg.type === 'SET_POSITION') {
            if (this.wasmExports && this.wasmExports.set_source_position) {
                // Direct C function call: void set_source_position(int id, float x, float y, float z)
                this.wasmExports.set_source_position(msg.sourceId, msg.x, msg.y, msg.z);
            }
        } else if (msg.type === 'RESET_SOURCE') {
            if (this.wasmExports && this.wasmExports.reset_source) {
                this.wasmExports.reset_source(msg.sourceId);
            }
        }
    }

    async initializeWasm(wasmModule, hrirData, sampleRate) {
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

        // Instantiate WebAssembly module
        let instantiated;
        if (wasmModule && (wasmModule instanceof WebAssembly.Module || typeof wasmModule === 'object')) {
            instantiated = await WebAssembly.instantiate(wasmModule, importObject);
        } else if (wasmModule instanceof ArrayBuffer || ArrayBuffer.isView(wasmModule)) {
            const compiled = await WebAssembly.compile(wasmModule);
            instantiated = await WebAssembly.instantiate(compiled, importObject);
        } else {
            throw new Error('Invalid WebAssembly module supplied to SpatialWorkletProcessor.');
        }

        // WebAssembly.instantiate returns either an Instance (when passed a Module) or { instance, module } (when passed bytes)
        this.wasmInstance = instantiated.instance ? instantiated.instance : instantiated;
        this.wasmExports = this.wasmInstance.exports;
        if (this.wasmExports.memory) {
            this.wasmMemory = this.wasmExports.memory;
        }

        // Initialize C++ spatial engine
        if (this.wasmExports.init_engine) {
            this.wasmExports.init_engine(sampleRate || 48000);
        }

        // Preallocate fixed I/O blocks in Wasm linear memory
        const bytesPerBlock = this.BLOCK_SIZE * 4; // 128 floats * 4 bytes = 512 bytes
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

        // Load HRIR dataset if provided
        if (hrirData && hrirData.numPositions > 0 && hrirData.filterLen > 0) {
            this.loadHrirData(hrirData);
        } else {
            // Default synthesized stereo frontal HRIR
            this.loadDefaultHrir();
        }

        this.isReady = true;
    }

    updateHeapViews() {
        // Cache typed array view without reallocations
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
        // Synthesize a clean default 2-position HRIR (left/right ear delta impulses)
        const filterLen = 512;
        const numPositions = 2;
        const leftHrir = new Float32Array(numPositions * filterLen);
        const rightHrir = new Float32Array(numPositions * filterLen);

        // Pos 0: Left Ear dominant
        leftHrir[0] = 0.95;
        rightHrir[10] = 0.3; // ITD ~10 samples delay + ILD attenuation
        // Pos 1: Right Ear dominant
        leftHrir[filterLen + 10] = 0.3;
        rightHrir[filterLen] = 0.95;

        this.loadHrirData({
            leftHrir,
            rightHrir,
            numPositions,
            filterLen
        });
    }

    /**
     * @brief Real-time audio rendering loop.
     * ZERO allocations inside this callback.
     */
    process(inputs, outputs, parameters) {
        const output = outputs[0];
        if (!output || output.length < 2) return true;

        const outLeftChannel = output[0];
        const outRightChannel = output[1];

        // Clear output stereo buffers
        outLeftChannel.fill(0);
        outRightChannel.fill(0);

        if (!this.isReady) {
            return true;
        }

        // Validate buffer view in case of rare memory growth
        if (this.heapF32.buffer !== this.wasmMemory.buffer) {
            this.updateHeapViews();
        }

        const heap = this.heapF32;
        const lOffset = this.outLeftOffset;
        const rOffset = this.outRightOffset;
        const processAudio = this.wasmExports.process_audio;

        // Process up to 4 input stems (0: drums, 1: bass, 2: vocals, 3: other)
        const activeInputCount = Math.min(inputs.length, this.NUM_SOURCES);

        for (let i = 0; i < activeInputCount; ++i) {
            const input = inputs[i];
            if (!input || input.length === 0) continue;

            const inChannel = input[0];
            if (!inChannel || inChannel.length !== this.BLOCK_SIZE) continue;

            // Direct memory copy into pre-allocated Wasm input buffer
            heap.set(inChannel, this.inOffsets[i]);

            // Call compiled C++ DSP engine
            processAudio(
                i,
                this.inPtrs[i],
                this.outLeftPtr,
                this.outRightPtr,
                this.BLOCK_SIZE
            );

            // Accumulate stereo binaural channels into output
            for (let n = 0; n < this.BLOCK_SIZE; ++n) {
                outLeftChannel[n] += heap[lOffset + n];
                outRightChannel[n] += heap[rOffset + n];
            }
        }

        return true;
    }
}

registerProcessor('spatial-worklet-processor', SpatialWorkletProcessor);
