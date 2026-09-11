# GEMINI.md - AuraStream Workspace Guidelines & Behavioral Rules

Welcome to **AuraStream** — an ultra-low latency, real-time spatial audio platform featuring a zero-allocation C++ WebAssembly DSP engine, a Python FastAPI stem extraction microservice, an interactive Next.js 3D spatial soundstage canvas, and a multi-client sub-50ms synchronization layer.

This file establishes operating instructions, technical invariants, directory structure mappings, and command references for **Gemini / Antigravity** agents operating within this repository.

---

## 🎯 Core Operating Invariants

Any agent modifying code in this repository **must** strictly uphold these five architectural invariants:

### 1. Zero-Allocation Real-Time Audio Thread Safety
- **Rule**: Absolutely **no dynamic memory allocation** (`malloc`, `new`, `free`, `delete`, `std::vector::resize`, `std::vector::push_back`, `std::string`) or system calls inside `process_audio()` or the AudioWorklet `process()` method.
- **Enforcement**: All memory buffers, FFT workspaces, twiddle factors, and cross-fade gain ramps must be allocated during initialisation (`init_engine()`) or class construction.
- **Audio Thread Latency**: Block processing must complete well within the real-time budget ($2.67\text{ms}$ for 128 samples at 48kHz; our C++ DSP benchmark targets $< 50\,\mu\text{s}$).

### 2. Sample-Accurate Phase & Length Alignment
- **Rule**: All stems extracted by the Python microservice (`drums`, `bass`, `vocals`, `other`) must maintain **identical sample length**, exact phase alignment, and 16-bit 48kHz PCM WAV format.
- **Enforcement**: Do not trim or pad individual stems unevenly. Sinc resampling (via `torchaudio.transforms.Resample` or scipy Kaiser) must be applied uniformly across all stems.

### 3. Pure Vanilla CSS & Modern Aesthetics (No TailwindCSS)
- **Rule**: All frontend styling **must use Vanilla CSS** with CSS custom properties (design tokens). **Do not install or use TailwindCSS**.
- **Enforcement**: Use the curated design system in `frontend/app/globals.css`. Maintain dark-mode first, glassmorphism (`backdrop-filter: blur()`), glowing cyan/magenta/gold accents, and fluid transitions.

### 4. Lookahead Transport Scheduling (<50ms Target)
- **Rule**: Never trigger audio playback immediately across distributed clients upon receiving a network packet.
- **Enforcement**: Transport playback is synchronized via NTP wall-clock time estimation and scheduled into the future ($T_{\text{target}} = T_{\text{server}} + 150\text{ms}$) mapped to `AudioContext.currentTime`.

### 5. Continuous Jitter Smoothing (Cubic Hermite Spline)
- **Rule**: Spatial node updates $(x, y, z)$ broadcasted over the network must not cause abrupt positional jumps or acoustic zipper noise.
- **Enforcement**: Receiver clients must buffer and interpolate coordinates using the 40ms `JitterBuffer` with Catmull-Rom tangents ($C^1$ continuity).

---

## 📁 Repository Directory Map

```
Binauralis/
├── include/                      # C++ DSP Headers
│   ├── AudioMath.h               # Coordinates (Cartesian <-> Spherical) & Distance Attenuation
│   ├── AuraStreamCAPI.h          # C-style API (extern "C") with Emscripten exports
│   ├── BinauralConvolver.h       # Fast Overlap-Add FIR engine with dual-convolver cross-fading
│   └── FastFFT.h                 # 1024-point Real-to-Complex Cooley-Tukey Radix-2 FFT
├── src/                          # C++ DSP Implementations
│   ├── AuraStreamCAPI.cpp        # Exported C API wrappers & memory management
│   ├── BinauralConvolver.cpp     # Zero-allocation FIR convolution & gain ramping
│   └── FastFFT.cpp               # FFT execution with precomputed twiddle tables
├── test/                         # Native C++ Unit Tests & Benchmarks
│   └── test_main.cpp             # 6 test cases verifying allocations, latency, & cross-fading
├── service/                      # Python FastAPI Ingestion & Telemetry Microservice
│   ├── core/
│   │   ├── loudness.py           # ITU-R BS.1770-4 / EBU R128 Loudness (LUFS, LU, True Peak)
│   │   ├── stem_separator.py     # Demucs (htdemucs) 4-stem separation & phase alignment
│   │   └── task_queue.py         # Asynchronous background job queue
│   ├── tests/
│   │   └── test_service.py       # Pytest cases for endpoints, loudness, and stems
│   └── main.py                   # FastAPI application routes (/api/stems/*, /api/telemetry/*)
├── web/                          # Web Audio & AudioWorklet Bridge
│   ├── SpatialAudioEngine.ts     # AudioContext manager, 4-stem transport, HRIR resampling
│   ├── SpatialWorkletProcessor.js# AudioWorkletProcessor memory-mapping Wasm linear memory
│   └── tests/
│       └── test_web_engine.mjs   # Node.js tests for Web Audio Worklet integration
├── frontend/                     # Next.js 3D Spatial Canvas Workstation
│   ├── app/
│   │   ├── globals.css           # Vanilla CSS tokens, glassmorphism, responsive styles
│   │   └── page.tsx              # Main studio page uniting 3D Canvas, HUD, & transport
│   ├── components/
│   │   ├── SpatialCanvas3D.tsx   # Three.js 3D canvas with draggable stem nodes & avatars
│   │   ├── SpatialTelemetryHUD.tsx# Glassmorphic HUD overlay with -14 LUFS Spotify meter
│   │   └── shaders/              # Dynamic GLSL Fresnel pulsing halo shaders
│   │       ├── haloFragment.glsl.ts
│   │       └── haloVertex.glsl.ts
│   └── hooks/
│       └── useSpatialSession.ts  # Typed hook syncing 3D canvas state with Web Audio
├── sync/                         # Multi-Client Real-Time Synchronization Layer
│   ├── ClockSync.ts              # NTP-style Cristian's algorithm with EMA filtering
│   ├── JitterBuffer.ts           # Cubic Hermite spline buffer (40ms window)
│   ├── protocol.ts               # Wire protocol types (PING, PONG, SYNC_TRANSPORT, NODE_MOVE)
│   ├── server.ts                 # WebSocket synchronization server
│   ├── SyncClient.ts             # Client-side sync driver
│   └── tests/
│       └── sync_system.test.ts   # Multi-client RTT, clock offset, & transport tests
├── storage/                      # Session outputs & uploaded audio storage
│   ├── sessions/                 # Job directories with extracted 4-stem 48kHz WAVs
│   └── uploads/                  # Temporary upload files
├── Makefile                      # Root automation for building, testing, and running
├── requirements.txt              # Python microservice dependencies
├── CLAUDE.md                     # Claude Code developer instructions
├── CHAT.md                       # Conversational AI guide & architectural rationale
└── GEMINI.md                     # Gemini / Antigravity workspace rules (this file)
```

---

## ⚡ Command Reference & Development Workflows

Agents should use the root `Makefile` targets to build, test, and run components:

### 1. Verification & Testing
```bash
# Run the complete test suite across all layers:
make run_tests     # Native C++ DSP tests & 10000-block latency benchmark
make test_web      # Node.js Web AudioWorklet memory-mapping tests
make test_service  # Pytest FastAPI stem extraction & loudness tests
make test_frontend # Next.js TypeScript typecheck
make test_sync     # Multi-client NTP clock sync & jitter buffer tests
```

### 2. Compilation (Emscripten WebAssembly)
```bash
# Compile C++ DSP into WebAssembly:
make wasm              # Outputs build/aurastream.js & build/aurastream.wasm (-O3, -msimd128)
make standalone_wasm   # Outputs build/aurastream_standalone.wasm
```

### 3. Running Services
```bash
make run_service   # FastAPI Audio Ingestion & Telemetry Service (http://localhost:8000)
make run_frontend  # Next.js 3D Spatial Canvas (http://localhost:3000)
make run_sync      # WebSocket Synchronization Server (ws://localhost:8080)
```

---

## 📐 Code Style & Technical Specifications

| Domain | Standard / Framework | Critical Guidelines |
| :--- | :--- | :--- |
| **C++ DSP** | C++17, Clang / Emscripten | Google C++ Style, `alignas(16)` buffers, zero allocations in audio loop, `extern "C"` exports. |
| **Python** | Python 3.12, FastAPI, PyTorch | PEP 8, Pydantic v2 schemas, type annotations, Kaiser sinc resampling, 16-bit 48kHz PCM output. |
| **TypeScript** | TypeScript 5.0+, Node ESM | Strict mode (`strict: true`), ESM relative imports (`.js` extension where required), explicit interfaces. |
| **Frontend** | Next.js 14 App Router, Three.js | Vanilla CSS only (design tokens in `globals.css`), GLSL Fresnel shaders, responsive HUD. |
| **Sync** | WebSocket, TypeScript | NTP Cristian's algorithm, EMA smoothing, scheduled transport lookahead, Cubic Hermite spline. |

---

## 🔍 Validation Checklist for Gemini Agents

Before marking any task complete or proposing changes:
- [ ] Run `make run_tests` — Ensure 0 dynamic allocations detected in the C++ benchmark.
- [ ] Run `make test_service` — Verify Demucs stem alignment and ITU-R BS.1770-4 loudness compliance.
- [ ] Run `make test_web` — Ensure AudioWorklet memory-mapping functions correctly.
- [ ] Run `make test_frontend` — Ensure TypeScript typecheck passes with no errors.
- [ ] Run `make test_sync` — Ensure multi-client clock offset is $< 1\text{ms}$ and transport skew is $< 1\text{ms}$.
- [ ] Confirm no TailwindCSS was introduced.
