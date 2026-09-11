#include "FastFFT.h"
#include <cmath>
#include <cstring>

namespace AuraStream {

FastFFT1024::FastFFT1024() {
    init_tables();
}

void FastFFT1024::init_tables() {
    // 1. Initialize 10-bit bit-reversal permutation table
    for (uint32_t i = 0; i < FFT_SIZE; ++i) {
        uint32_t rev = 0;
        uint32_t val = i;
        for (size_t j = 0; j < LOG2_SIZE; ++j) {
            rev = (rev << 1) | (val & 1);
            val >>= 1;
        }
        bit_rev_[i] = static_cast<uint16_t>(rev);
    }

    // 2. Precompute trigonometric twiddle factors: W_N^k = e^(-j * 2*pi*k / N)
    const double pi_const = 3.14159265358979323846;
    for (size_t k = 0; k < HALF_SIZE; ++k) {
        double angle = -2.0 * pi_const * static_cast<double>(k) / static_cast<double>(FFT_SIZE);
        twiddle_cos_[k] = static_cast<float>(std::cos(angle));
        twiddle_sin_[k] = static_cast<float>(std::sin(angle));
    }
}

void FastFFT1024::transform(Complex32* __restrict data, bool inverse) const {
    // Cooley-Tukey Radix-2 decimation-in-time butterflies
    for (size_t s = 1; s <= LOG2_SIZE; ++s) {
        const size_t m = static_cast<size_t>(1) << s;
        const size_t m2 = m >> 1;
        const size_t step = FFT_SIZE / m;

        for (size_t j = 0; j < m2; ++j) {
            const size_t tw_idx = j * step;
            const float wr = twiddle_cos_[tw_idx];
            // Twiddle imaginary sign flips for inverse FFT
            const float wi = inverse ? -twiddle_sin_[tw_idx] : twiddle_sin_[tw_idx];

            for (size_t k = 0; k < FFT_SIZE; k += m) {
                const size_t idx_a = k + j;
                const size_t idx_b = idx_a + m2;

                const float br = data[idx_b].r;
                const float bi = data[idx_b].i;

                // Complex multiply: t = w * data[idx_b]
                const float tr = wr * br - wi * bi;
                const float ti = wr * bi + wi * br;

                const float ar = data[idx_a].r;
                const float ai = data[idx_a].i;

                data[idx_a].r = ar + tr;
                data[idx_a].i = ai + ti;
                data[idx_b].r = ar - tr;
                data[idx_b].i = ai - ti;
            }
        }
    }

    if (inverse) {
        constexpr float norm = 1.0f / static_cast<float>(FFT_SIZE);
        for (size_t i = 0; i < FFT_SIZE; ++i) {
            data[i].r *= norm;
            data[i].i *= norm;
        }
    }
}

void FastFFT1024::forward_real(
    const float* __restrict input,
    Complex32* __restrict output,
    Complex32* __restrict scratch
) const {
    // 1. Bit-reversal permutation from real input into complex scratchpad
    for (size_t i = 0; i < FFT_SIZE; ++i) {
        const uint16_t rev_idx = bit_rev_[i];
        scratch[rev_idx].r = input[i];
        scratch[rev_idx].i = 0.0f;
    }

    // 2. Perform in-place FFT on scratchpad
    transform(scratch, false);

    // 3. Store result in output
    std::memcpy(output, scratch, FFT_SIZE * sizeof(Complex32));
}

void FastFFT1024::inverse_real(
    const Complex32* __restrict input,
    float* __restrict output,
    Complex32* __restrict scratch
) const {
    // 1. Bit-reversal permutation from complex spectrum into complex scratchpad
    for (size_t i = 0; i < FFT_SIZE; ++i) {
        scratch[bit_rev_[i]] = input[i];
    }

    // 2. Perform in-place IFFT on scratchpad
    transform(scratch, true);

    // 3. Extract real component
    for (size_t i = 0; i < FFT_SIZE; ++i) {
        output[i] = scratch[i].r;
    }
}

void FastFFT1024::complex_multiply(
    const Complex32* __restrict a,
    const Complex32* __restrict b,
    Complex32* __restrict out,
    size_t count
) {
    for (size_t k = 0; k < count; ++k) {
        const float ar = a[k].r;
        const float ai = a[k].i;
        const float br = b[k].r;
        const float bi = b[k].i;

        out[k].r = ar * br - ai * bi;
        out[k].i = ar * bi + ai * br;
    }
}

} // namespace AuraStream
