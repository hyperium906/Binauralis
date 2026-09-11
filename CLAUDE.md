# CLAUDE.md - AuraStream Spatial Audio Platform Guidelines

AuraStream is a high-performance, real-time spatial audio platform featuring a C++ WebAssembly DSP engine, a Python FastAPI stem extraction microservice, an interactive Next.js 3D spatial canvas, and a multi-client real-time synchronization layer.

---

## 🛠️ Build & Test Commands

Run all tests via the root `Makefile`:

```bash
# Complete platform test suite
make run_tests     # 1. Native C++ BinauralConvolver DSP & 10000-block latency benchmark
make test_web      # 2. AudioWorklet memory-mapping & Web Audio engine tests
make test_service  # 3. Python FastAPI Demucs stem extraction & ITU-R BS.1770-4 tests
make test_frontend # 4. Next.js 3D Spatial Canvas TypeScript typecheck
make test_sync     # 5. Multi-Client NTP clock sync & Cubic Hermite jitter buffer tests

# Compile WebAssembly DSP Engine (Emscripten)
make wasm              # Builds build/aurastream.js & build/aurastream.wasm (-O3, -msimd128)
make standalone_wasm   # Builds build/aurastream_standalone.wasm

# Service Launch Commands
make run_service   # Start FastAPI Audio Ingestion & Telemetry Service (http://localhost:8000)
make run_frontend  # Start Next.js 3D Spatial Canvas Workstation (http://localhost:3000)
make run_sync      # Start WebSocket Synchronization Server (ws://localhost:8080)
```

---

## 📐 Architecture & Real-Time Audio Constraints

### 1. C++ Real-Time DSP Engine (`include/`, `src/`)
- **Strict Real-Time Safety**: Zero dynamic memory allocations (`malloc`, `new`, `std::vector::resize`) inside `process_audio()` or any block callback.
- **Fast Overlap-Add FIR Convolution**: Processes standard **128-sample blocks** using a built-in 1024-point Real-to-Complex FFT with precomputed twiddles and bit-reversal tables.
- **Filter Specifications**: 512-tap stereo Head-Related Impulse Responses (HRIR) per position.
- **Acoustic Attenuation & Anti-Zipper**:
  - Inverse-square distance law: $g(d) = \frac{d_{ref}}{\max(d, d_{min})}$ with $d_{min} = 0.5\text{m}$.
  - Sample-accurate linear gain ramping: $g[n] = g_{start} + n \cdot \Delta g$ across all 128 samples.
- **Anti-Click Dual-Convolver Cross-Fade**: When a source moves across spatial HRIR boundaries, smoothly cross-fades between active and target filters over 128 samples to prevent transient pops.

### 2. Python Audio Ingestion & Telemetry Service (`service/`)
- **Demucs 4-Stem Extraction**: Uses `htdemucs` to separate tracks into `drums`, `bass`, `vocals`, and `other`.
- **Sample-Accurate Phase & Length Alignment**: Enforces identical sample count across all 4 stems, resampled via Kaiser sinc interpolation to **16-bit 48kHz WAV**.
- **Broadcast Telemetry**: ITU-R BS.1770-4 / EBU R128 dual-gated Integrated Loudness (LUFS), Loudness Range (LU), and $4\times$ oversampled True Peak (dBFS).
- **Asynchronous Task Queue**: `POST /api/stems/extract` returns `202 Accepted` with a UUID `job_id`, polled via `GET /api/stems/status/{job_id}`.

### 3. Web Audio & AudioWorklet Bridge (`web/`)
- **`SpatialWorkletProcessor.js`**:
  - Memory-maps fixed `WebAssembly.Memory` pointers for 4-stem inputs and stereo binaural output.
  - Zero heap object/array allocations inside `process()`.
  - Lock-free parameter updates via `port.onmessage`.
- **`SpatialAudioEngine.ts`**:
  - Manages `AudioContext`, registers worklet, and coordinates 4-stem playback using `currentTime + 0.05` lookahead scheduling.
  - **Sample Rate Mismatch Mitigation**: Detects 44.1 kHz hardware and automatically resamples HRIR tables via an in-memory `OfflineAudioContext`.

### 4. Next.js 3D Spatial Canvas (`frontend/`)
- **Technology**: Next.js App Router, TypeScript, Three.js, Vanilla CSS.
- **Scene**: Central listener avatar at $(0, 0, 0)$ with orientation cone along $+Y$, four draggable orbital stem nodes with height drop lines, and bounding stage sphere ($R \in [0.5, 3.0]\text{m}$).
- **Dynamic GLSL Halos**: Custom Fresnel rim glow fragment shaders pulsing with real-time audio amplitude (`uRms`) and time (`uTime`).
- **Telemetry HUD**: Glassmorphic overlay displaying real-time coordinates, azimuth, elevation, distance attenuation, and an integrated **-14 LUFS Spotify target meter**.

### 5. Multi-Client Real-Time Synchronization (`sync/`)
- **NTP-Style Clock Synchronization**: Continuous ping/pong measuring RTT and clock offset ($\Delta t$) with low-latency weighting and EMA filtering ($< 1\text{ms}$ accuracy).
- **Scheduled Transport Sync**: `SYNC_TRANSPORT` broadcasts future target server timestamps ($T_{\text{target}} = T_{\text{server}} + 150\text{ms}$), achieving sub-millisecond playback alignment across remote peers.
- **Client-Side Jitter Smoothing**: Cubic Hermite Spline buffer with a 40ms interpolation window to eliminate packet burst stepping and Doppler artifacts.

---

## 🎨 Code Style & Conventions

- **C++**: C++17, Google C++ Style Guide, `snake_case` functions/variables, `PascalCase` classes, trailing underscore for private members (`member_`), `alignas(16)` on audio buffers.
- **TypeScript / JavaScript**: Strict typing, ESM modules, `camelCase` functions/variables, `PascalCase` classes/interfaces, 4-space indentation.
- **CSS**: Vanilla CSS design tokens, HSL color palettes, dark mode first, glassmorphism `backdrop-filter: blur()`, no TailwindCSS.
- **Python**: PEP 8, Type hints, FastAPI dependency injection, Pydantic v2 validation models.
