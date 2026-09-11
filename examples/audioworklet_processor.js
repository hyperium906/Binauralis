/**
 * AuraStream WebAudio AudioWorklet Integration Example
 * Demonstrates high-performance zero-allocation binaural rendering using AuraStream WebAssembly.
 */

class AuraStreamProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        this.wasmInstance = null;
        this.wasmExports = null;
        this.inputPtr = 0;
        this.outLeftPtr = 0;
        this.outRightPtr = 0;
        this.blockSize = 128;

        this.port.onmessage = (e) => {
            const data = e.data;
            if (data.type === 'INIT_WASM') {
                this.initEngine(data.wasmBytes, data.hrirData, sampleRate);
            } else if (data.type === 'SET_POSITION') {
                if (this.wasmExports) {
                    this.wasmExports.set_source_position(data.sourceId, data.x, data.y, data.z);
                }
            }
        };
    }

    async initEngine(wasmBytes, hrirData, sr) {
        const module = await WebAssembly.instantiate(wasmBytes, {
            env: {
                memory: new WebAssembly.Memory({ initial: 256, maximum: 1024 }),
                abort: () => console.error("AuraStream Wasm Abort!")
            }
        });

        this.wasmExports = module.instance.exports;
        this.wasmExports.init_engine(sr);

        // Preallocate audio I/O buffers in Wasm heap (128 floats each)
        const bytesPerBlock = this.blockSize * 4;
        this.inputPtr = this.wasmExports.malloc(bytesPerBlock);
        this.outLeftPtr = this.wasmExports.malloc(bytesPerBlock);
        this.outRightPtr = this.wasmExports.malloc(bytesPerBlock);

        // Upload HRIR table if provided
        if (hrirData) {
            const totalHrirFloats = hrirData.numPositions * hrirData.filterLen;
            const hrirBytes = totalHrirFloats * 4;
            const leftHrirPtr = this.wasmExports.malloc(hrirBytes);
            const rightHrirPtr = this.wasmExports.malloc(hrirBytes);

            const heapF32 = new Float32Array(this.wasmExports.memory.buffer);
            heapF32.set(hrirData.leftFilters, leftHrirPtr / 4);
            heapF32.set(hrirData.rightFilters, rightHrirPtr / 4);

            this.wasmExports.load_hrir_table(
                leftHrirPtr,
                rightHrirPtr,
                hrirData.numPositions,
                hrirData.filterLen
            );

            this.wasmExports.free(leftHrirPtr);
            this.wasmExports.free(rightHrirPtr);
        }

        this.port.postMessage({ type: 'ENGINE_READY' });
    }

    process(inputs, outputs, parameters) {
        if (!this.wasmExports || !this.inputPtr) return true;

        const input = inputs[0];
        const output = outputs[0];

        if (!input || input.length === 0 || !output || output.length < 2) return true;

        const inputChannel = input[0];
        const outputLeft = output[0];
        const outputRight = output[1];

        const memory = this.wasmExports.memory.buffer;
        const heapF32 = new Float32Array(memory);

        // Copy input samples directly into preallocated Wasm heap
        heapF32.set(inputChannel, this.inputPtr / 4);

        // Process real-time block (Source 0)
        this.wasmExports.process_audio(
            0,
            this.inputPtr,
            this.outLeftPtr,
            this.outRightPtr,
            this.blockSize
        );

        // Copy output binaural channels into WebAudio output buffers
        outputLeft.set(heapF32.subarray(this.outLeftPtr / 4, (this.outLeftPtr / 4) + this.blockSize));
        outputRight.set(heapF32.subarray(this.outRightPtr / 4, (this.outRightPtr / 4) + this.blockSize));

        return true;
    }
}

registerProcessor('aurastream-processor', AuraStreamProcessor);
