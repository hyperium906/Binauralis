#pragma once

#include "AudioMath.h"
#include "FastFFT.h"
#include <cstdint>
#include <cstddef>
#include <vector>

namespace AuraStream {

/**
 * @brief Maximum system capabilities configured at compile/init time.
 */
inline constexpr size_t AUDIO_BLOCK_SIZE = 128;
inline constexpr size_t HRIR_FILTER_LEN = 512;
inline constexpr size_t FFT_LEN = 1024;
inline constexpr size_t OVERLAP_SIZE = HRIR_FILTER_LEN; // 512 samples tail
inline constexpr size_t MAX_AUDIO_SOURCES = 32;
inline constexpr size_t MAX_HRIR_POSITIONS = 512;

/**
 * @brief State tracking for an individual 3D audio source.
 */
struct alignas(16) SourceState {
    float x = 0.0f;
    float y = 1.0f;
    float z = 0.0f;

    float current_gain = 1.0f;
    float target_gain = 1.0f;

    int active_hrir_idx = 0;
    int target_hrir_idx = 0;
    bool is_crossfading = false;
    bool is_active = false;

    // Overlap-add persistent tail accumulators (left & right ears)
    alignas(16) float overlap_left[OVERLAP_SIZE] = {0.0f};
    alignas(16) float overlap_right[OVERLAP_SIZE] = {0.0f};

    void reset() {
        x = 0.0f; y = 1.0f; z = 0.0f;
        current_gain = 1.0f; target_gain = 1.0f;
        active_hrir_idx = 0; target_hrir_idx = 0;
        is_crossfading = false;
        is_active = false;
        for (size_t i = 0; i < OVERLAP_SIZE; ++i) {
            overlap_left[i] = 0.0f;
            overlap_right[i] = 0.0f;
        }
    }
};

/**
 * @brief Spatial entry in the precomputed HRIR dataset.
 */
struct HRIRSpatialEntry {
    UnitVector3D direction;
    // Precomputed frequency domain spectrums for 1024-point FFT
    std::vector<Complex32> spectrum_left;
    std::vector<Complex32> spectrum_right;
};

/**
 * @brief Dolby-grade Real-Time Binaural Spatial Convolver.
 * 
 * Strictly satisfies real-time audio constraints:
 * 1. Zero heap allocations (malloc/new) inside process_audio().
 * 2. 128-sample block-based Fast Overlap-Add FIR convolution using 1024-point FFT.
 * 3. 512-tap HRIR stereo filters (left and right ear).
 * 4. Sample-accurate gain interpolation (inverse-square law) and dual-convolver cross-fading.
 */
class BinauralConvolver {
public:
    explicit BinauralConvolver(int sample_rate = 48000);
    ~BinauralConvolver() = default;

    // Non-copyable for audio thread safety
    BinauralConvolver(const BinauralConvolver&) = delete;
    BinauralConvolver& operator=(const BinauralConvolver&) = delete;

    /**
     * @brief Initialize or reconfigure audio engine.
     * @param sample_rate Audio sampling rate (e.g. 48000, 44100).
     */
    void init(int sample_rate);

    /**
     * @brief Load Head-Related Impulse Response (HRIR) table into engine.
     * Precomputes frequency-domain representations for zero-allocation runtime.
     * 
     * @param left_hrir Interleaved/concatenated left ear filters [num_positions * filter_len].
     * @param right_hrir Interleaved/concatenated right ear filters [num_positions * filter_len].
     * @param num_positions Number of spatial positions in table.
     * @param filter_len Length of each filter (must be <= HRIR_FILTER_LEN = 512).
     * @return true on success, false if invalid arguments.
     */
    bool load_hrir_table(
        const float* left_hrir,
        const float* right_hrir,
        int num_positions,
        int filter_len
    );

    /**
     * @brief Update 3D position of an audio source.
     * Thread-safe, lock-free parameter update.
     * 
     * @param source_id Index of audio source [0, MAX_AUDIO_SOURCES - 1].
     * @param x Right coordinate (+X = Right, -X = Left).
     * @param y Forward coordinate (+Y = Forward, -Y = Behind).
     * @param z Up coordinate (+Z = Up, -Z = Down).
     */
    void set_source_position(int source_id, float x, float y, float z);

    /**
     * @brief Real-time audio rendering block callback.
     * CRITICAL: ZERO dynamic memory allocations occur inside this method.
     * 
     * @param source_id Source index.
     * @param input_buffer Monophonic input audio buffer.
     * @param out_left Left ear binaural output buffer.
     * @param out_right Right ear binaural output buffer.
     * @param num_samples Number of samples to process (must be multiple of AUDIO_BLOCK_SIZE = 128).
     */
    void process_audio(
        int source_id,
        const float* __restrict input_buffer,
        float* __restrict out_left,
        float* __restrict out_right,
        int num_samples
    );

    /**
     * @brief Configure custom 3D direction for an HRIR position index.
     */
    void set_hrir_direction(int pos_index, float azimuth_rad, float elevation_rad);

    /**
     * @brief Clear all state for a source: overlap-add tails, gain ramp,
     * filter selection and active flag.
     *
     * Not real-time safe to call concurrently with process_audio() for the same
     * source; call it while that source is silent.
     *
     * @param source_id Source index [0, MAX_AUDIO_SOURCES - 1].
     */
    void reset_source(int source_id);

    int sample_rate() const { return sample_rate_; }
    int num_positions() const { return num_positions_; }

private:
    int sample_rate_ = 48000;
    int num_positions_ = 0;
    int filter_len_ = HRIR_FILTER_LEN;

    FastFFT1024 fft_;

    // Source states pre-allocated for real-time safety
    SourceState sources_[MAX_AUDIO_SOURCES];

    // Pre-allocated HRIR spatial table
    HRIRSpatialEntry hrir_table_[MAX_HRIR_POSITIONS];

    // --- Pre-allocated Real-Time Scratchpads (Never allocated in audio callback) ---
    alignas(16) float scratch_input_padded_[FFT_LEN];
    alignas(16) Complex32 scratch_fft_in_[FFT_LEN];
    alignas(16) Complex32 scratch_fft_out_[FFT_LEN];
    alignas(16) Complex32 scratch_spec_curr_L_[FFT_LEN];
    alignas(16) Complex32 scratch_spec_curr_R_[FFT_LEN];
    alignas(16) Complex32 scratch_spec_targ_L_[FFT_LEN];
    alignas(16) Complex32 scratch_spec_targ_R_[FFT_LEN];
    alignas(16) float scratch_time_curr_L_[FFT_LEN];
    alignas(16) float scratch_time_curr_R_[FFT_LEN];
    alignas(16) float scratch_time_targ_L_[FFT_LEN];
    alignas(16) float scratch_time_targ_R_[FFT_LEN];

    /**
     * @brief Find nearest HRIR index for a given direction vector.
     */
    int find_nearest_hrir_index(const UnitVector3D& dir) const;

    /**
     * @brief Internal processing for a single 128-sample block.
     */
    void process_single_block(
        SourceState& src,
        const float* __restrict input_block,
        float* __restrict out_left,
        float* __restrict out_right
    );
};

} // namespace AuraStream
