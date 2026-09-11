#pragma once

#include <cstdint>
#include <cstddef>

namespace AuraStream {

/**
 * @brief 1024-point complex number structure aligned for SIMD vectorization.
 */
struct alignas(8) Complex32 {
    float r;
    float i;

    inline Complex32 operator+(const Complex32& o) const { return { r + o.r, i + o.i }; }
    inline Complex32 operator-(const Complex32& o) const { return { r - o.r, i - o.i }; }
    inline Complex32 operator*(const Complex32& o) const {
        return { r * o.r - i * o.i, r * o.i + i * o.r };
    }
};

/**
 * @brief High-performance, self-contained 1024-point FFT/IFFT.
 * 
 * Strictly real-time safe:
 * - Pre-computes bit-reversal and trigonometric twiddle tables at construction.
 * - Zero dynamic heap allocation in any transform call.
 * - Single-precision Cooley-Tukey Radix-2 butterfly with cache-resident working set (8 KB).
 */
class FastFFT1024 {
public:
    static constexpr size_t FFT_SIZE = 1024;
    static constexpr size_t LOG2_SIZE = 10;
    static constexpr size_t HALF_SIZE = FFT_SIZE / 2;

    FastFFT1024();
    ~FastFFT1024() = default;

    // Prevent copies to safeguard fixed-size internal tables
    FastFFT1024(const FastFFT1024&) = delete;
    FastFFT1024& operator=(const FastFFT1024&) = delete;

    /**
     * @brief Forward Real-to-Complex FFT (1024 real samples -> 1024 complex bins).
     * @param input Real input buffer of 1024 samples (caller zero-pads tail).
     * @param output 1024 complex bins.
     * @param scratch Scratchpad buffer of 1024 Complex32 elements provided by caller/engine.
     */
    void forward_real(const float* __restrict input, Complex32* __restrict output, Complex32* __restrict scratch) const;

    /**
     * @brief Inverse Complex-to-Real FFT.
     * @param input 1024 complex spectrum bins.
     * @param output Real output buffer of 1024 samples.
     * @param scratch Scratchpad buffer of 1024 Complex32 elements provided by caller/engine.
     */
    void inverse_real(const Complex32* __restrict input, float* __restrict output, Complex32* __restrict scratch) const;

    /**
     * @brief Complex vector multiply-accumulate: out[k] = A[k] * B[k].
     */
    static void complex_multiply(
        const Complex32* __restrict a,
        const Complex32* __restrict b,
        Complex32* __restrict out,
        size_t count = FFT_SIZE
    );

    /**
     * @brief In-place complex transform.
     */
    void transform(Complex32* __restrict data, bool inverse) const;

private:
    uint16_t bit_rev_[FFT_SIZE];
    float twiddle_cos_[HALF_SIZE];
    float twiddle_sin_[HALF_SIZE];

    void init_tables();
};

} // namespace AuraStream
