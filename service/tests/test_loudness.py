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

def _tone_at(target_lufs: float, duration_sec: float, sample_rate: int = 48000) -> np.ndarray:
    """A 1 kHz stereo sine calibrated to a target integrated loudness."""
    n = int(duration_sec * sample_rate)
    t = np.arange(n) / sample_rate
    base = np.column_stack((np.sin(2 * np.pi * 1000 * t),) * 2).astype(np.float32) * 0.1
    measured = LoudnessTelemetryAnalyzer._integrated_loudness(base, sample_rate)
    return (base * 10 ** ((target_lufs - measured) / 20)).astype(np.float32)


def test_k_weighting_matches_bs1770_response():
    """
    The K-weighting cascade must match the normative BS.1770-4 response.

    Regression: the filter was built with btype='highshelf', which scipy does
    not accept, so the native analysis path raised ValueError on every call.
    """
    from scipy import signal

    spec_b = np.convolve(
        [1.53512485958697, -2.69169618940638, 1.19839281085285], [1.0, -2.0, 1.0]
    )
    spec_a = np.convolve(
        [1.0, -1.69065929318241, 0.73248077421585],
        [1.0, -1.99004745483398, 0.99007225036621],
    )

    sr = 48000
    impulse = np.zeros((16384, 1), dtype=np.float32)
    impulse[0, 0] = 1.0
    h = LoudnessTelemetryAnalyzer._k_weight(impulse, sr)[:, 0]

    w, h_impl = signal.freqz(h, 1, worN=8192, fs=sr)
    _, h_spec = signal.freqz(spec_b, spec_a, worN=8192, fs=sr)

    band = (w > 20) & (w < 20000)
    err = np.abs(
        20 * np.log10(np.abs(h_impl) + 1e-30) - 20 * np.log10(np.abs(h_spec) + 1e-30)
    )[band].max()
    assert err < 0.01, f"K-weighting deviates from BS.1770-4 by {err:.4f} dB"


@pytest.mark.parametrize(
    "levels, expected",
    [
        ((-20.0, -30.0), 10.0),
        ((-20.0, -15.0), 5.0),
        ((-40.0, -20.0), 20.0),
        ((-50.0, -35.0, -20.0), 15.0),
    ],
)
def test_loudness_range_ebu_tech_3342(levels, expected):
    """
    EBU Tech 3342 reference cases.

    Regression: the previous code called pyln.loudness_range(), which does not
    exist. The AttributeError was swallowed by a bare except and every track
    reported a loudness range of exactly 0.0.
    """
    sig = np.concatenate([_tone_at(lv, 20.0) for lv in levels], axis=0)
    lra = LoudnessTelemetryAnalyzer._loudness_range(np.clip(sig, -1.0, 1.0), 48000)
    assert abs(lra - expected) <= 1.0, f"Expected LRA near {expected} LU, got {lra}"


def test_loudness_range_is_reported_and_nonzero():
    """A dynamic programme must report a non-zero range end to end."""
    sig = np.clip(
        np.concatenate([_tone_at(-30.0, 20.0), _tone_at(-20.0, 20.0)], axis=0), -1.0, 1.0
    )
    buf = io.BytesIO()
    sf.write(buf, sig, 48000, format="WAV", subtype="PCM_16")
    buf.seek(0)

    res = LoudnessTelemetryAnalyzer.analyze(buf.read(), filename="dynamic.wav")
    assert res.loudness_range_lu > 5.0, (
        f"Dynamic programme reported LRA {res.loudness_range_lu} LU"
    )

    # A steady tone, by contrast, has essentially no range.
    steady = np.clip(_tone_at(-20.0, 30.0), -1.0, 1.0)
    assert LoudnessTelemetryAnalyzer._loudness_range(steady, 48000) < 1.0


def test_native_path_without_pyloudnorm(monkeypatch):
    """The fallback analysis must work when pyloudnorm is unavailable."""
    import service.core.loudness as loudness_mod

    monkeypatch.setattr(loudness_mod, "HAS_PYLOUDNORM", False)

    sig = np.clip(
        np.concatenate([_tone_at(-30.0, 20.0), _tone_at(-20.0, 20.0)], axis=0), -1.0, 1.0
    )
    buf = io.BytesIO()
    sf.write(buf, sig, 48000, format="WAV", subtype="PCM_16")
    buf.seek(0)

    res = LoudnessTelemetryAnalyzer.analyze(buf.read(), filename="native.wav")
    assert -30.0 < res.integrated_loudness_lufs < -15.0
    assert res.loudness_range_lu > 5.0


if __name__ == "__main__":
    test_true_peak_accuracy()
    test_loudness_telemetry_analysis()
    test_silence_handling()
    test_k_weighting_matches_bs1770_response()
    test_loudness_range_is_reported_and_nonzero()
    print("All Loudness unit tests passed successfully!")
