import io
import math
import numpy as np
import soundfile as sf
import pytest

from service.core.loudness import LoudnessTelemetryAnalyzer

def generate_test_wav(
    frequency_hz: float = 1000.0,
    amplitude: float = 0.1,  # -20 dBFS peak
    duration_sec: float = 3.0,
    sample_rate: int = 48000
) -> bytes:
    """
    Synthesizes a stereo test sine wave in memory as 16-bit WAV bytes.
    """
    total_samples = int(duration_sec * sample_rate)
    t = np.linspace(0, duration_sec, total_samples, endpoint=False)
    # Sine wave
    signal = amplitude * np.sin(2.0 * np.pi * frequency_hz * t)
    stereo = np.column_stack((signal, signal)).astype(np.float32)

    buf = io.BytesIO()
    sf.write(buf, stereo, sample_rate, format="WAV", subtype="PCM_16")
    buf.seek(0)
    return buf.read()

def test_true_peak_accuracy():
    # 0.1 amplitude corresponds to 20 * log10(0.1) = -20.0 dBFS
    wav_bytes = generate_test_wav(frequency_hz=1000.0, amplitude=0.1, duration_sec=1.0)
    data, sr = LoudnessTelemetryAnalyzer.load_audio(wav_bytes)
    tp = LoudnessTelemetryAnalyzer.compute_true_peak(data, sr, oversample_factor=4)
    assert abs(tp - (-20.0)) < 0.5, f"Expected True Peak near -20.0 dBFS, got {tp}"

def test_loudness_telemetry_analysis():
    # 3 second test tone
    wav_bytes = generate_test_wav(frequency_hz=1000.0, amplitude=0.1, duration_sec=3.0)
    res = LoudnessTelemetryAnalyzer.analyze(wav_bytes, filename="test_1khz.wav")

    assert res.filename == "test_1khz.wav"
    assert res.sample_rate == 48000
    assert res.channels == 2
    assert res.duration_seconds >= 2.9
    assert abs(res.true_peak_dbfs - (-20.0)) < 0.5
    # Standard BS.1770 K-weighting at 1kHz gives integrated loudness near -20.0 LUFS for 0.1 peak amplitude
    assert -21.0 <= res.integrated_loudness_lufs <= -19.0

def test_silence_handling():
    silence = np.zeros((48000, 2), dtype=np.float32)
    buf = io.BytesIO()
    sf.write(buf, silence, 48000, format="WAV")
    buf.seek(0)
    res = LoudnessTelemetryAnalyzer.analyze(buf.read(), filename="silence.wav")
    assert res.integrated_loudness_lufs <= -69.0
    assert res.true_peak_dbfs <= -100.0

if __name__ == "__main__":
    test_true_peak_accuracy()
    test_loudness_telemetry_analysis()
    test_silence_handling()
    print("All Loudness unit tests passed successfully!")
