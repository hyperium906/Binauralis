# CHAT.md - AuraStream Conversational AI Guide & Architecture Rationale

This document serves as the primary technical context and reasoning manual for conversational AI assistants (ChatGPT, Claude, Gemini, etc.) and engineers discussing, debugging, or extending the **AuraStream Spatial Audio Platform**.

---

## 🎙️ AI Persona & Technical Stance

When answering questions about AuraStream, adopt the persona of a **Principal Audio Systems & Infrastructure Engineer** (veteran of Dolby, Spotify, and IRCAM):
- **Uncompromising Real-Time Safety**: The audio render thread is sacred. No dynamic allocations (`malloc`/`new`), no mutex locks, no unbounded loops, no file I/O, and no garbage collection.
- **Psychoacoustic Rigor**: Consider ITD (Interaural Time Difference), ILD (Interaural Level Difference), spectral pinna cues, head shadow, and Doppler effects when discussing spatial perception.
- **Sample-Accurate Synchronization**: Remote collaboration requires wall-clock time estimation, network jitter mitigation, and deterministic audio buffer scheduling.
- **Pragmatic Modern Web Architecture**: High-performance C++ WebAssembly for DSP, AudioWorklet for low-latency audio processing, FastAPI for ML audio processing, Three.js/GLSL for spatial visualization, and WebSockets for sub-50ms multi-peer sync.

---

## 🏛️ High-Level System Architecture

```
                                  +---------------------------------------+
                                  |    Source Audio (.wav / .mp3 / etc.)  |
                                  +---------------------------------------+
                                                      |
                                                      v
                                  +---------------------------------------+
                                  |       FastAPI Microservice (8000)     |
                                  |  - Demucs (htdemucs) 4-stem extractor |
                                  |  - 16-bit 48kHz WAV alignment         |
                                  |  - ITU-R BS.1770-4 / EBU R128 loudness|
                                  +---------------------------------------+
                                                      |
                          +---------------------------+---------------------------+
                          | Stems: drums, bass, vocals, other                     |
                          v                                                       v
        +-----------------------------------+                   +-----------------------------------+
        |       Client A (Browser)          |                   |       Client B (Browser)          |
        |  Next.js 3D Canvas (Three.js)     |                   |  Next.js 3D Canvas (Three.js)     |
        |  SpatialTelemetryHUD (-14 LUFS)   |                   |  SpatialTelemetryHUD (-14 LUFS)   |
        |                 |                 |                   |                 |                 |
        |        Web Audio Engine           |                   |        Web Audio Engine           |
        |   SpatialAudioEngine (Web Audio)  |                   |   SpatialAudioEngine (Web Audio)  |
        |                 |                 |                   |                 |                 |
        |       AudioWorklet Thread         |                   |       AudioWorklet Thread         |
        |   SpatialWorkletProcessor.js      |                   |   SpatialWorkletProcessor.js      |
        |   binaural_engine.wasm (C++ DSP)  |                   |   binaural_engine.wasm (C++ DSP)  |
        +-----------------------------------+                   +-----------------------------------+
                          ^                                                       ^
                          |                                                       |
                          +------------------- WebSocket Sync -------------------+
                                            (ws://localhost:8080)
                                            - NTP Clock Sync (<1ms)
                                            - Scheduled Transport
                                            - Cubic Hermite Jitter Buffer
```

---

## 🔬 Core Engineering Rationale & Architectural Decisions

### 1. Fast Overlap-Add FIR vs. Direct Time-Domain Convolution
- **The Problem**: A 512-tap HRIR per ear across 4 simultaneous stems requires $4 \times 2 \times 512 = 4,096$ multiply-accumulate operations per output sample, or $\approx 196.6\text{M}$ operations/sec at 48kHz. Direct FIR convolution causes audio buffer under-runs and high CPU burn.
- **The Solution**: AuraStream implements partitioned **Fast Overlap-Add (OLA) frequency-domain convolution** using a 1024-point real-to-complex FFT with precomputed twiddle and bit-reversal tables.
- **Complexity**: Reduces per-sample computational complexity from $O(L)$ to $O(\log N)$, yielding a $13.5\,\mu\text{s}$ block processing time ($> 190\times$ faster than real-time for 128 samples at 48kHz).

### 2. Dual-Convolver Cross-Fading vs. Parameter Snapping
- **The Problem**: When a sound source moves across HRIR measurement points, snapping filter coefficients abruptly introduces high-frequency phase discontinuities perceived as audible clicks and pops.
- **The Solution**: AuraStream employs a **dual-convolver cross-fader**. When a source's spatial position changes, convolution starts immediately on the target filter bank while fading out the active filter bank over exactly 128 samples ($\approx 2.67\text{ms}$ at 48kHz). Once cross-fading completes, the target filter becomes the active filter with zero phase distortion.

### 3. Inverse-Square Law with $d_{\min} = 0.5\text{m}$ & Linear Gain Ramping
- **The Problem**: As $d \to 0$, the inverse-square distance law $1/d^2$ diverges to infinity, causing numerical clipping and extreme distortion. Furthermore, instantaneous gain updates produce zipper noise.
- **The Solution**: Gain is clamped below $d_{\min} = 0.5\text{m}$:
  $$g(d) = \frac{d_{\text{ref}}}{\max(d, d_{\min})}$$
  Within each 128-sample block, gain is linearly ramped from $g_{\text{start}}$ to $g_{\text{target}}$:
  $$g[n] = g_{\text{start}} + n \cdot \frac{g_{\text{target}} - g_{\text{start}}}{128}$$

### 4. AudioWorklet Linear Memory Mapping & Zero Allocations
- **The Problem**: JavaScript garbage collection runs intermittently on the main thread and can pause audio execution, leading to buffer dropouts ("stutter").
- **The Solution**: `SpatialWorkletProcessor` compiles and maps `aurastream.wasm` directly into fixed linear memory (`WebAssembly.Memory`). Input and output buffers are allocated once during initialisation. The audio loop (`process()`) executes zero JavaScript object creations or allocations.

### 5. Multi-Client Synchronization: Future-Scheduled Transport & Cubic Hermite Jitter Buffer
- **The Problem**: Uncoordinated play commands across remote peers suffer variable network latencies, creating audible echo and soundstage disorientation. Position updates transmitted over UDP/WebSocket jitter, producing stepping artifacts.
- **The Solution**:
  1. **Clock Sync**: Continuous NTP-style ping/pong exchange using Cristian's algorithm calculates Round-Trip Time (RTT) and clock offset ($\Delta t$) filtered by an Exponential Moving Average (EMA).
  2. **Future-Scheduled Transport**: Instead of immediate playback, `SYNC_TRANSPORT` broadcasts a target server timestamp $T_{\text{target}} = T_{\text{server}} + 150\text{ms}$. Each client maps this to its local `AudioContext.currentTime` with sub-millisecond precision.
  3. **Cubic Hermite Spline Smoothing**: The receiving client uses a 40ms jitter buffer with Catmull-Rom finite-difference tangents, providing $C^1$ velocity continuity and preventing abrupt positional jumps.

---

## 💬 Conversational Scenarios & Prompt Templates

When discussing or requesting enhancements for AuraStream, use the following prompts:

### Scenario 1: Expanding the DSP Engine
> *"How can we add early reflection room acoustics (Shoebox image-source model) to `BinauralConvolver` while preserving zero-allocation real-time safety?"*
- **Key focus**: Pre-allocating delay line ring buffers, maintaining SIMD alignment, and calculating wall absorption filters within the 128-sample block.

### Scenario 2: Web Audio Sample Rate Compatibility
> *"A user connects Bluetooth headphones at 44.1 kHz, but our HRIR tables are recorded at 48 kHz. How does AuraStream handle this?"*
- **Key focus**: Review `SpatialAudioEngine.resampleHRIR()` which provisions an in-memory `OfflineAudioContext` to resample 512-tap filter responses to the destination hardware rate.

### Scenario 3: Real-Time Telemetry & Metering
> *"How does AuraStream compute ITU-R BS.1770-4 loudness on the backend, and how does the frontend display it?"*
- **Key focus**: Explain the K-weighting pre-filter (high-shelf + high-pass), $400\text{ms}$ momentary gating, $-70\text{dBFS}$ absolute and $-10\text{LU}$ relative gating, $4\times$ oversampled True Peak detection, and the frontend glassmorphic HUD meter.

---

## 🧰 Quick Command Cheat Sheet

```bash
# DSP Engine Tests & Latency Benchmark
make run_tests

# Python Demucs & Loudness Microservice Tests
make test_service

# Web AudioWorklet Tests
make test_web

# Frontend Typecheck
make test_frontend

# Multi-Client NTP & Sync Tests
make test_sync

# Launch Services
make run_service   # FastAPI Backend (:8000)
make run_frontend  # Next.js 3D Frontend (:3000)
make run_sync      # WebSocket Sync Server (:8080)
```
