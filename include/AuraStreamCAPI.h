#pragma once

#ifdef __cplusplus
extern "C" {
#endif

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#define AURASTREAM_API EMSCRIPTEN_KEEPALIVE
#else
#if defined(_WIN32)
#define AURASTREAM_API __declspec(dllexport)
#else
#define AURASTREAM_API __attribute__((visibility("default")))
#endif
#endif

/**
 * @brief Initialize the global spatial audio engine with target sample rate.
 * @param sample_rate Audio sample rate in Hz (e.g. 48000).
 * @return 0 on success, non-zero on failure.
 */
AURASTREAM_API int init_engine(int sample_rate);

/**
 * @brief Load Head-Related Impulse Response (HRIR) filter database.
 * Precomputes frequency-domain representations for zero-allocation runtime.
 * 
 * @param left_hrir Interleaved left-ear filters [num_positions * filter_len].
 * @param right_hrir Interleaved right-ear filters [num_positions * filter_len].
 * @param num_positions Number of spatial positions in table.
 * @param filter_len Length of each filter (taps <= 512).
 * @return 0 on success, non-zero on failure.
 */
AURASTREAM_API int load_hrir_table(
    const float* left_hrir,
    const float* right_hrir,
    int num_positions,
    int filter_len
);

/**
 * @brief Update 3D coordinates for a specific audio source.
 * Thread-safe, lock-free parameter update with smooth gain and cross-fade scheduling.
 * 
 * @param source_id Source index [0, 31].
 * @param x Right axis coordinate (+X = Right, -X = Left).
 * @param y Forward axis coordinate (+Y = Front, -Y = Behind).
 * @param z Up axis coordinate (+Z = Up, -Z = Down).
 */
AURASTREAM_API void set_source_position(int source_id, float x, float y, float z);

/**
 * @brief Real-time audio rendering callback for a specific audio source.
 * STRICT REAL-TIME SAFE: Zero heap allocations, zero locks, deterministic execution.
 * 
 * @param source_id Source index [0, 31].
 * @param input_buffer Monophonic input audio buffer.
 * @param out_left Output buffer for left ear binaural audio.
 * @param out_right Output buffer for right ear binaural audio.
 * @param num_samples Number of samples to process (must be a multiple of 128).
 */
AURASTREAM_API void process_audio(
    int source_id,
    const float* input_buffer,
    float* out_left,
    float* out_right,
    int num_samples
);

/**
 * @brief Optional: Set explicit spherical coordinates for an HRIR index.
 */
AURASTREAM_API void set_hrir_direction(int pos_index, float azimuth_rad, float elevation_rad);

/**
 * @brief Reset internal states and tail buffers for a source.
 */
AURASTREAM_API void reset_source(int source_id);

/**
 * @brief Get audio engine constants.
 */
AURASTREAM_API int get_block_size();
AURASTREAM_API int get_max_filter_len();
AURASTREAM_API int get_max_sources();

#ifdef __cplusplus
}
#endif
