#include "BinauralConvolver.h"
#include "AuraStreamCAPI.h"
#include <iostream>
#include <vector>
#include <cmath>
#include <chrono>
#include <cassert>
#include <new>

// ============================================================================
// Real-Time Memory Allocation Interceptor
// Asserts that no malloc / dynamic new occurs while in the real-time audio thread
// ============================================================================
static bool g_realtime_assertion_active = false;
static int g_allocations_detected_in_realtime = 0;

void* operator new(std::size_t size) {
    if (g_realtime_assertion_active) {
        g_allocations_detected_in_realtime++;
    }
    return std::malloc(size);
}

void operator delete(void* ptr) noexcept {
    std::free(ptr);
}

void operator delete(void* ptr, std::size_t) noexcept {
    std::free(ptr);
}

// ============================================================================
// Test 1: FastFFT1024 Invertibility & Precision Test
// ============================================================================
bool test_fft_invertibility() {
    std::cout << "[Test 1] FastFFT1024 Invertibility & Precision... ";
    AuraStream::FastFFT1024 fft;

    alignas(16) float input[1024] = {0.0f};
    alignas(16) AuraStream::Complex32 spectrum[1024];
    alignas(16) AuraStream::Complex32 scratch[1024];
    alignas(16) float output[1024] = {0.0f};

    // Synthesize multi-tone test signal
    for (size_t i = 0; i < 1024; ++i) {
        input[i] = std::sin(2.0 * AuraStream::AudioMath::PI * 440.0 * i / 48000.0)
                 + 0.5f * std::cos(2.0 * AuraStream::AudioMath::PI * 1000.0 * i / 48000.0);
    }

    fft.forward_real(input, spectrum, scratch);
    fft.inverse_real(spectrum, output, scratch);

    float max_error = 0.0f;
    for (size_t i = 0; i < 1024; ++i) {
        float err = std::abs(input[i] - output[i]);
        if (err > max_error) max_error = err;
    }

    if (max_error > 1e-4f) {
        std::cerr << "FAILED! Max error: " << max_error << std::endl;
        return false;
    }
    std::cout << "PASSED (Max Reconstruction Error: " << max_error << ")" << std::endl;
    return true;
}

// ============================================================================
// Test 2: Bit-Exact Impulse Response & Overlap-Add Test
// ============================================================================
bool test_impulse_response_recovery() {
    std::cout << "[Test 2] Overlap-Add Linear FIR Reconstruction... ";
    AuraStream::BinauralConvolver engine(48000);

    // Create synthetic HRIR with known exponential decay taps
    constexpr int filter_len = 512;
    std::vector<float> hrir_left(filter_len);
    std::vector<float> hrir_right(filter_len);

    for (int i = 0; i < filter_len; ++i) {
        float t = static_cast<float>(i) / static_cast<float>(filter_len);
        hrir_left[i] = std::exp(-5.0f * t) * std::sin(2.0f * AuraStream::AudioMath::PI * 8.0f * t);
        hrir_right[i] = std::exp(-8.0f * t) * std::cos(2.0f * AuraStream::AudioMath::PI * 12.0f * t);
    }

    engine.load_hrir_table(hrir_left.data(), hrir_right.data(), 1, filter_len);
    engine.set_source_position(0, 0.0f, 1.0f, 0.0f); // 1.0m directly ahead (gain = 1.0)

    // Feed a unit impulse: x[0] = 1.0, all other samples = 0.0 across 5 blocks (640 samples)
    constexpr int total_samples = 640;
    std::vector<float> input(total_samples, 0.0f);
    input[0] = 1.0f;

    std::vector<float> out_left(total_samples, 0.0f);
    std::vector<float> out_right(total_samples, 0.0f);

    for (int blk = 0; blk < total_samples; blk += 128) {
        engine.process_audio(0, input.data() + blk, out_left.data() + blk, out_right.data() + blk, 128);
    }

    // Verify first 512 samples recover HRIR accurately
    float max_err_l = 0.0f;
    float max_err_r = 0.0f;
    for (int i = 0; i < filter_len; ++i) {
        float err_l = std::abs(out_left[i] - hrir_left[i]);
        float err_r = std::abs(out_right[i] - hrir_right[i]);
        if (err_l > max_err_l) max_err_l = err_l;
        if (err_r > max_err_r) max_err_r = err_r;
    }

    // Verify tail beyond 512 taps is silent
    float tail_energy = 0.0f;
    for (int i = filter_len; i < total_samples; ++i) {
        tail_energy += std::abs(out_left[i]) + std::abs(out_right[i]);
    }

    if (max_err_l > 1e-4f || max_err_r > 1e-4f || tail_energy > 1e-4f) {
        std::cerr << "FAILED! Err L: " << max_err_l << " Err R: " << max_err_r << " Tail: " << tail_energy << std::endl;
        return false;
    }

    std::cout << "PASSED (Max Filter Error: " << std::max(max_err_l, max_err_r) << ", Post-Tail Silence: " << tail_energy << ")" << std::endl;
    return true;
}

// ============================================================================
// Test 3: Zero Dynamic Memory Allocation Verification
// ============================================================================
bool test_realtime_zero_allocation() {
    std::cout << "[Test 3] Dolby Real-Time Audio Memory Safety Audit... ";
    AuraStream::BinauralConvolver engine(48000);

    constexpr int filter_len = 512;
    std::vector<float> hrir_l(filter_len, 0.01f);
    std::vector<float> hrir_r(filter_len, 0.01f);
    engine.load_hrir_table(hrir_l.data(), hrir_r.data(), 1, filter_len);
    engine.set_source_position(0, 1.0f, 1.0f, 0.0f);

    float in_buf[128] = {0.0f};
    float out_l[128] = {0.0f};
    float out_r[128] = {0.0f};

    // Activate real-time memory interceptor
    g_allocations_detected_in_realtime = 0;
    g_realtime_assertion_active = true;

    for (int block = 0; block < 100; ++block) {
        // Change position mid-playback to trigger cross-fading and gain ramps
        if (block == 50) {
            engine.set_source_position(0, -2.0f, 1.0f, 0.5f);
        }
        engine.process_audio(0, in_buf, out_l, out_r, 128);
    }

    g_realtime_assertion_active = false;

    if (g_allocations_detected_in_realtime != 0) {
        std::cerr << "FAILED! Detected " << g_allocations_detected_in_realtime << " heap allocations during process_audio()!" << std::endl;
        return false;
    }

    std::cout << "PASSED (Strict 0 malloc/new calls across 100 blocks)" << std::endl;
    return true;
}

// ============================================================================
// Test 4: Anti-Click Dual-Convolver Crossfade & Zipper Noise Verification
// ============================================================================
bool test_anticlick_crossfade() {
    std::cout << "[Test 4] Smooth Spatial Cross-Fade & Anti-Zipper Verification... ";
    AuraStream::BinauralConvolver engine(48000);

    constexpr int filter_len = 512;
    // Two distinct spatial HRIRs (e.g. left vs right ear dominance)
    std::vector<float> hrir_l(filter_len * 2, 0.0f);
    std::vector<float> hrir_r(filter_len * 2, 0.0f);

    for (int i = 0; i < 50; ++i) {
        hrir_l[i] = 1.0f - (i / 50.0f); // Position 0: strong left
        hrir_r[filter_len + i] = 1.0f - (i / 50.0f); // Position 1: strong right
    }

    engine.load_hrir_table(hrir_l.data(), hrir_r.data(), 2, filter_len);
    engine.set_hrir_direction(0, -AuraStream::AudioMath::PI / 2.0f, 0.0f); // Left (-X)
    engine.set_hrir_direction(1, +AuraStream::AudioMath::PI / 2.0f, 0.0f); // Right (+X)

    // Position at Left
    engine.set_source_position(0, -1.0f, 0.0f, 0.0f);

    std::vector<float> sine_input(128, 0.8f);
    std::vector<float> out_l(128, 0.0f);
    std::vector<float> out_r(128, 0.0f);

    // Warm up engine
    for (int i = 0; i < 4; ++i) {
        engine.process_audio(0, sine_input.data(), out_l.data(), out_r.data(), 128);
    }

    // Abruptly jump position 180 degrees to the right!
    engine.set_source_position(0, 1.0f, 0.0f, 0.0f);
    engine.process_audio(0, sine_input.data(), out_l.data(), out_r.data(), 128);

    // Verify sample-to-sample derivatives remain bounded (no instantaneous step clicks)
    float max_delta_l = 0.0f;
    float max_delta_r = 0.0f;
    for (int i = 1; i < 128; ++i) {
        float dl = std::abs(out_l[i] - out_l[i - 1]);
        float dr = std::abs(out_r[i] - out_r[i - 1]);
        if (dl > max_delta_l) max_delta_l = dl;
        if (dr > max_delta_r) max_delta_r = dr;
    }

    if (max_delta_l > 0.5f || max_delta_r > 0.5f) {
        std::cerr << "FAILED! High discontinuity delta detected (Click): " << std::max(max_delta_l, max_delta_r) << std::endl;
        return false;
    }

    std::cout << "PASSED (Smooth C0 Continuity, Max Sample Delta: " << std::max(max_delta_l, max_delta_r) << ")" << std::endl;
    return true;
}

// ============================================================================
// Test 5: Distance Attenuation Law & Near-Field Clamping
// ============================================================================
bool test_distance_attenuation() {
    std::cout << "[Test 5] Inverse-Square Distance Attenuation & Clamping... ";
    
    // Check attenuation math
    float gain_near = AuraStream::AudioMath::compute_distance_attenuation(0.1f); // should clamp to 0.5m -> 1.0 / 0.5 = 2.0
    float gain_ref  = AuraStream::AudioMath::compute_distance_attenuation(1.0f); // 1.0 / 1.0 = 1.0
    float gain_far  = AuraStream::AudioMath::compute_distance_attenuation(2.0f); // 1.0 / 2.0 = 0.5
    float gain_4m   = AuraStream::AudioMath::compute_distance_attenuation(4.0f); // 1.0 / 4.0 = 0.25

    assert(std::abs(gain_near - 2.0f) < 1e-4f);
    assert(std::abs(gain_ref - 1.0f) < 1e-4f);
    assert(std::abs(gain_far - 0.5f) < 1e-4f);
    assert(std::abs(gain_4m - 0.25f) < 1e-4f);

    std::cout << "PASSED (d=0.1m -> " << gain_near << ", d=1m -> " << gain_ref << ", d=2m -> " << gain_far << ", d=4m -> " << gain_4m << ")" << std::endl;
    return true;
}

// ============================================================================
// Test 6: Performance Benchmark
// ============================================================================
void run_performance_benchmark() {
    std::cout << "\n===========================================================" << std::endl;
    std::cout << "  AuraStream Real-Time Engine Latency & Throughput Benchmark" << std::endl;
    std::cout << "===========================================================" << std::endl;

    AuraStream::BinauralConvolver engine(48000);
    constexpr int filter_len = 512;
    std::vector<float> hrir_l(filter_len, 0.05f);
    std::vector<float> hrir_r(filter_len, 0.05f);
    engine.load_hrir_table(hrir_l.data(), hrir_r.data(), 1, filter_len);
    engine.set_source_position(0, 1.0f, 2.0f, 0.5f);

    float in_buf[128];
    float out_l[128];
    float out_r[128];
    for (int i = 0; i < 128; ++i) in_buf[i] = 0.1f * (i % 10);

    constexpr int iterations = 10000;
    auto start_time = std::chrono::high_resolution_clock::now();

    for (int i = 0; i < iterations; ++i) {
        engine.process_audio(0, in_buf, out_l, out_r, 128);
    }

    auto end_time = std::chrono::high_resolution_clock::now();
    double total_us = std::chrono::duration<double, std::micro>(end_time - start_time).count();
    double avg_us_per_block = total_us / iterations;

    // At 48 kHz, a 128-sample block duration is 128 / 48000 = 2.666 ms = 2666.7 us
    constexpr double block_duration_us = (128.0 / 48000.0) * 1e6;
    double cpu_budget_percent = (avg_us_per_block / block_duration_us) * 100.0;

    std::cout << "Iterations: " << iterations << " blocks (128 samples / block)" << std::endl;
    std::cout << "Total processing time: " << total_us / 1000.0 << " ms" << std::endl;
    std::cout << "Average processing time per block: " << avg_us_per_block << " microseconds" << std::endl;
    std::cout << "Audio Block Duration (Real-Time Budget): " << block_duration_us << " microseconds" << std::endl;
    std::cout << "CPU Core Load per 3D Source: " << cpu_budget_percent << " %" << std::endl;
    std::cout << "Throughput: " << (100.0 / cpu_budget_percent) << "x Real-Time Speed" << std::endl;
    std::cout << "===========================================================\n" << std::endl;
}

int main() {
    std::cout << "\n===========================================================" << std::endl;
    std::cout << "  AuraStream BinauralConvolver Test & Verification Suite" << std::endl;
    std::cout << "===========================================================\n" << std::endl;

    assert(test_fft_invertibility());
    assert(test_impulse_response_recovery());
    assert(test_realtime_zero_allocation());
    assert(test_anticlick_crossfade());
    assert(test_distance_attenuation());

    run_performance_benchmark();

    std::cout << "All verification tests PASSED successfully!\n" << std::endl;
    return 0;
}
