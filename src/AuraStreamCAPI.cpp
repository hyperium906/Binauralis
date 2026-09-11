#include "AuraStreamCAPI.h"
#include "BinauralConvolver.h"
#include <memory>

static std::unique_ptr<AuraStream::BinauralConvolver> g_engine = nullptr;

int init_engine(int sample_rate) {
    if (sample_rate <= 0) {
        sample_rate = 48000;
    }
    g_engine = std::make_unique<AuraStream::BinauralConvolver>(sample_rate);
    return g_engine ? 0 : -1;
}

int load_hrir_table(
    const float* left_hrir,
    const float* right_hrir,
    int num_positions,
    int filter_len
) {
    if (!g_engine) {
        init_engine(48000);
    }
    bool success = g_engine->load_hrir_table(left_hrir, right_hrir, num_positions, filter_len);
    return success ? 0 : -1;
}

void set_source_position(int source_id, float x, float y, float z) {
    if (g_engine) {
        g_engine->set_source_position(source_id, x, y, z);
    }
}

void process_audio(
    int source_id,
    const float* input_buffer,
    float* out_left,
    float* out_right,
    int num_samples
) {
    if (g_engine) {
        g_engine->process_audio(source_id, input_buffer, out_left, out_right, num_samples);
    }
}

void set_hrir_direction(int pos_index, float azimuth_rad, float elevation_rad) {
    if (g_engine) {
        g_engine->set_hrir_direction(pos_index, azimuth_rad, elevation_rad);
    }
}

void reset_source(int source_id) {
    // Re-setting source position at origin resets the internal state
    if (g_engine) {
        g_engine->set_source_position(source_id, 0.0f, 1.0f, 0.0f);
    }
}

int get_block_size() {
    return static_cast<int>(AuraStream::AUDIO_BLOCK_SIZE);
}

int get_max_filter_len() {
    return static_cast<int>(AuraStream::HRIR_FILTER_LEN);
}

int get_max_sources() {
    return static_cast<int>(AuraStream::MAX_AUDIO_SOURCES);
}
