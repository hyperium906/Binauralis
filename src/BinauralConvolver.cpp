#include "BinauralConvolver.h"
#include <cstring>
#include <cmath>
#include <algorithm>

namespace AuraStream {

BinauralConvolver::BinauralConvolver(int sample_rate) {
    init(sample_rate);
}

void BinauralConvolver::init(int sample_rate) {
    sample_rate_ = sample_rate;
    num_positions_ = 0;
    filter_len_ = HRIR_FILTER_LEN;

    for (size_t i = 0; i < MAX_AUDIO_SOURCES; ++i) {
        sources_[i].reset();
    }

    // Zero-out all real-time scratchpads
    std::memset(scratch_input_padded_, 0, sizeof(scratch_input_padded_));
    std::memset(scratch_fft_in_, 0, sizeof(scratch_fft_in_));
    std::memset(scratch_fft_out_, 0, sizeof(scratch_fft_out_));
    std::memset(scratch_spec_curr_L_, 0, sizeof(scratch_spec_curr_L_));
    std::memset(scratch_spec_curr_R_, 0, sizeof(scratch_spec_curr_R_));
    std::memset(scratch_spec_targ_L_, 0, sizeof(scratch_spec_targ_L_));
    std::memset(scratch_spec_targ_R_, 0, sizeof(scratch_spec_targ_R_));
    std::memset(scratch_time_curr_L_, 0, sizeof(scratch_time_curr_L_));
    std::memset(scratch_time_curr_R_, 0, sizeof(scratch_time_curr_R_));
    std::memset(scratch_time_targ_L_, 0, sizeof(scratch_time_targ_L_));
    std::memset(scratch_time_targ_R_, 0, sizeof(scratch_time_targ_R_));
}

bool BinauralConvolver::load_hrir_table(
    const float* left_hrir,
    const float* right_hrir,
    int num_positions,
    int filter_len
) {
    if (!left_hrir || !right_hrir || num_positions <= 0 || filter_len <= 0) {
        return false;
    }
    if (num_positions > static_cast<int>(MAX_HRIR_POSITIONS) || filter_len > static_cast<int>(HRIR_FILTER_LEN)) {
        return false;
    }

    num_positions_ = num_positions;
    filter_len_ = filter_len;

    // Temporary real buffer for zero-padded 1024-point FFT precomputation
    alignas(16) float temp_time[FFT_LEN];
    alignas(16) Complex32 temp_scratch[FFT_LEN];

    for (int p = 0; p < num_positions; ++p) {
        HRIRSpatialEntry& entry = hrir_table_[p];

        // Allocate spectrum arrays (only performed here at initialization)
        entry.spectrum_left.resize(FFT_LEN);
        entry.spectrum_right.resize(FFT_LEN);

        // 1. Precompute default spatial direction if not already set
        if (num_positions <= 72) {
            // Horizontal circle: azimuth in [-pi, pi], elevation = 0
            float az = -AudioMath::PI + (AudioMath::TWO_PI * static_cast<float>(p) / static_cast<float>(num_positions));
            entry.direction = AudioMath::spherical_to_unit_vector(az, 0.0f);
        } else {
            // Fibonacci spherical distribution for uniform 3D sphere coverage
            const float y = 1.0f - (2.0f * static_cast<float>(p) + 1.0f) / static_cast<float>(num_positions);
            const float radius = std::sqrt(std::max(0.0f, 1.0f - y * y));
            constexpr float golden_ratio = 1.618033988749895f;
            const float phi = 2.0f * AudioMath::PI * static_cast<float>(p) / golden_ratio;
            entry.direction = UnitVector3D{ radius * std::cos(phi), radius * std::sin(phi), y };
        }

        // 2. Precompute Left Ear Frequency Response
        const float* left_filter = left_hrir + (p * filter_len);
        std::memcpy(temp_time, left_filter, filter_len * sizeof(float));
        std::memset(temp_time + filter_len, 0, (FFT_LEN - filter_len) * sizeof(float));
        fft_.forward_real(temp_time, entry.spectrum_left.data(), temp_scratch);

        // 3. Precompute Right Ear Frequency Response
        const float* right_filter = right_hrir + (p * filter_len);
        std::memcpy(temp_time, right_filter, filter_len * sizeof(float));
        std::memset(temp_time + filter_len, 0, (FFT_LEN - filter_len) * sizeof(float));
        fft_.forward_real(temp_time, entry.spectrum_right.data(), temp_scratch);
    }

    return true;
}

void BinauralConvolver::set_hrir_direction(int pos_index, float azimuth_rad, float elevation_rad) {
    if (pos_index >= 0 && pos_index < num_positions_) {
        hrir_table_[pos_index].direction = AudioMath::spherical_to_unit_vector(azimuth_rad, elevation_rad);
    }
}

int BinauralConvolver::find_nearest_hrir_index(const UnitVector3D& dir) const {
    if (num_positions_ <= 0) {
        return 0;
    }

    int best_idx = 0;
    float best_sim = -2.0f; // Cosine range is [-1, 1]

    for (int p = 0; p < num_positions_; ++p) {
        float sim = AudioMath::direction_similarity(dir, hrir_table_[p].direction);
        if (sim > best_sim) {
            best_sim = sim;
            best_idx = p;
        }
    }

    return best_idx;
}

void BinauralConvolver::set_source_position(int source_id, float x, float y, float z) {
    if (source_id < 0 || source_id >= static_cast<int>(MAX_AUDIO_SOURCES)) {
        return;
    }

    SourceState& src = sources_[source_id];
    src.x = x;
    src.y = y;
    src.z = z;

    const SphericalCoord sc = AudioMath::cartesian_to_spherical(x, y, z);
    const UnitVector3D dir = AudioMath::spherical_to_unit_vector(sc.azimuth_rad, sc.elevation_rad);

    // Compute target distance gain using inverse-square acoustic decay with near-field clamping
    src.target_gain = AudioMath::compute_distance_attenuation(sc.distance_m);

    // Find nearest HRIR filter from loaded database
    int target_idx = find_nearest_hrir_index(dir);

    if (!src.is_active) {
        // Initial positioning without crossfade
        src.active_hrir_idx = target_idx;
        src.target_hrir_idx = target_idx;
        src.current_gain = src.target_gain;
        src.is_crossfading = false;
        src.is_active = true;
    } else if (target_idx != src.active_hrir_idx) {
        // Position changed to a different spatial bin: schedule dual-convolver cross-fade
        src.target_hrir_idx = target_idx;
        src.is_crossfading = true;
    }
}

void BinauralConvolver::process_audio(
    int source_id,
    const float* __restrict input_buffer,
    float* __restrict out_left,
    float* __restrict out_right,
    int num_samples
) {
    if (source_id < 0 || source_id >= static_cast<int>(MAX_AUDIO_SOURCES) || !input_buffer || !out_left || !out_right) {
        return;
    }

    SourceState& src = sources_[source_id];
    if (num_positions_ <= 0) {
        // No HRIR loaded: zero output
        std::memset(out_left, 0, num_samples * sizeof(float));
        std::memset(out_right, 0, num_samples * sizeof(float));
        return;
    }

    // Process in standardized 128-sample real-time blocks
    for (int offset = 0; offset < num_samples; offset += AUDIO_BLOCK_SIZE) {
        process_single_block(
            src,
            input_buffer + offset,
            out_left + offset,
            out_right + offset
        );
    }
}

void BinauralConvolver::process_single_block(
    SourceState& src,
    const float* __restrict input_block,
    float* __restrict out_left,
    float* __restrict out_right
) {
    // -------------------------------------------------------------------------
    // 1. Zero-pad input block (128 samples -> 1024 points for linear convolution)
    // -------------------------------------------------------------------------
    std::memcpy(scratch_input_padded_, input_block, AUDIO_BLOCK_SIZE * sizeof(float));
    std::memset(scratch_input_padded_ + AUDIO_BLOCK_SIZE, 0, (FFT_LEN - AUDIO_BLOCK_SIZE) * sizeof(float));

    // -------------------------------------------------------------------------
    // 2. Forward FFT of input block
    // -------------------------------------------------------------------------
    fft_.forward_real(scratch_input_padded_, scratch_fft_out_, scratch_fft_in_);

    // -------------------------------------------------------------------------
    // 3. Convolve with Active HRIR in Frequency Domain
    // -------------------------------------------------------------------------
    const Complex32* hrir_active_L = hrir_table_[src.active_hrir_idx].spectrum_left.data();
    const Complex32* hrir_active_R = hrir_table_[src.active_hrir_idx].spectrum_right.data();

    FastFFT1024::complex_multiply(scratch_fft_out_, hrir_active_L, scratch_spec_curr_L_);
    FastFFT1024::complex_multiply(scratch_fft_out_, hrir_active_R, scratch_spec_curr_R_);

    fft_.inverse_real(scratch_spec_curr_L_, scratch_time_curr_L_, scratch_fft_in_);
    fft_.inverse_real(scratch_spec_curr_R_, scratch_time_curr_R_, scratch_fft_in_);

    // -------------------------------------------------------------------------
    // 4. Handle Dual-Convolver Cross-Fade if Source Moved Across Spatial Bins
    // -------------------------------------------------------------------------
    const bool is_crossfading = src.is_crossfading && (src.active_hrir_idx != src.target_hrir_idx);

    if (is_crossfading) {
        const Complex32* hrir_target_L = hrir_table_[src.target_hrir_idx].spectrum_left.data();
        const Complex32* hrir_target_R = hrir_table_[src.target_hrir_idx].spectrum_right.data();

        FastFFT1024::complex_multiply(scratch_fft_out_, hrir_target_L, scratch_spec_targ_L_);
        FastFFT1024::complex_multiply(scratch_fft_out_, hrir_target_R, scratch_spec_targ_R_);

        fft_.inverse_real(scratch_spec_targ_L_, scratch_time_targ_L_, scratch_fft_in_);
        fft_.inverse_real(scratch_spec_targ_R_, scratch_time_targ_R_, scratch_fft_in_);
    }

    // -------------------------------------------------------------------------
    // 5. Sample-Accurate Gain & Cross-Fade Output Synthesis (Anti-Zipper Noise)
    // -------------------------------------------------------------------------
    constexpr float inv_block_size = 1.0f / static_cast<float>(AUDIO_BLOCK_SIZE);
    const float gain_start = src.current_gain;
    const float gain_step = (src.target_gain - gain_start) * inv_block_size;

    if (!is_crossfading) {
        for (size_t n = 0; n < AUDIO_BLOCK_SIZE; ++n) {
            const float g = gain_start + static_cast<float>(n) * gain_step;
            out_left[n] = (scratch_time_curr_L_[n] + src.overlap_left[n]) * g;
            out_right[n] = (scratch_time_curr_R_[n] + src.overlap_right[n]) * g;
        }

        // Standard Overlap-Add Tail Shift & Accumulate (512 taps: 128 output + 384 tail)
        for (size_t n = 0; n < OVERLAP_SIZE - AUDIO_BLOCK_SIZE; ++n) {
            src.overlap_left[n] = src.overlap_left[n + AUDIO_BLOCK_SIZE] + scratch_time_curr_L_[n + AUDIO_BLOCK_SIZE];
            src.overlap_right[n] = src.overlap_right[n + AUDIO_BLOCK_SIZE] + scratch_time_curr_R_[n + AUDIO_BLOCK_SIZE];
        }
        for (size_t n = OVERLAP_SIZE - AUDIO_BLOCK_SIZE; n < OVERLAP_SIZE; ++n) {
            src.overlap_left[n] = scratch_time_curr_L_[n + AUDIO_BLOCK_SIZE];
            src.overlap_right[n] = scratch_time_curr_R_[n + AUDIO_BLOCK_SIZE];
        }
    } else {
        // Dual-convolver linear crossfade over 128 samples to prevent clicks and zipper noise
        for (size_t n = 0; n < AUDIO_BLOCK_SIZE; ++n) {
            const float alpha = static_cast<float>(n + 1) * inv_block_size;
            const float y_L = (1.0f - alpha) * scratch_time_curr_L_[n] + alpha * scratch_time_targ_L_[n];
            const float y_R = (1.0f - alpha) * scratch_time_curr_R_[n] + alpha * scratch_time_targ_R_[n];

            const float g = gain_start + static_cast<float>(n) * gain_step;
            out_left[n] = (y_L + src.overlap_left[n]) * g;
            out_right[n] = (y_R + src.overlap_right[n]) * g;
        }

        // At end of block, transition is complete; target HRIR becomes active
        for (size_t n = 0; n < OVERLAP_SIZE - AUDIO_BLOCK_SIZE; ++n) {
            src.overlap_left[n] = src.overlap_left[n + AUDIO_BLOCK_SIZE] + scratch_time_targ_L_[n + AUDIO_BLOCK_SIZE];
            src.overlap_right[n] = src.overlap_right[n + AUDIO_BLOCK_SIZE] + scratch_time_targ_R_[n + AUDIO_BLOCK_SIZE];
        }
        for (size_t n = OVERLAP_SIZE - AUDIO_BLOCK_SIZE; n < OVERLAP_SIZE; ++n) {
            src.overlap_left[n] = scratch_time_targ_L_[n + AUDIO_BLOCK_SIZE];
            src.overlap_right[n] = scratch_time_targ_R_[n + AUDIO_BLOCK_SIZE];
        }

        src.active_hrir_idx = src.target_hrir_idx;
        src.is_crossfading = false;
    }

    // Advance smooth distance gain state
    src.current_gain = src.target_gain;
}

} // namespace AuraStream
