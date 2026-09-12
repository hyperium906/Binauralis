import io
import math
from pathlib import Path
from typing import Union, Tuple
import numpy as np
import soundfile as sf
from scipy import signal

from service.models.schemas import LoudnessTelemetryResponse

try:
    import pyloudnorm as pyln
    HAS_PYLOUDNORM = True
except ImportError:
    HAS_PYLOUDNORM = False


class LoudnessTelemetryAnalyzer:
    """
    Broadcast-grade Audio Loudness and True Peak Analyzer.
    Strictly conforms to ITU-R BS.1770-4 and EBU R128 specifications.
    """

    @staticmethod
    def load_audio(file_source: Union[str, Path, io.BytesIO, bytes]) -> Tuple[np.ndarray, int]:
        """
        Load audio into normalized float32 numpy array [samples, channels] and sample_rate.
        """
        if isinstance(file_source, bytes):
            file_source = io.BytesIO(file_source)

        data, sr = sf.read(file_source, dtype='float32', always_2d=True)
        return data, sr

    @staticmethod
    def compute_true_peak(data: np.ndarray, sample_rate: int, oversample_factor: int = 4) -> float:
        """
        Calculates True Peak in dBFS using 4x polyphase oversampling
        in accordance with ITU-R BS.1770-4 Annex 2.
        """
        if data.size == 0:
            return -120.0

        # Resample along time axis (axis 0) by oversample factor (4x)
        try:
            oversampled = signal.resample_poly(data, oversample_factor, 1, axis=0)
            max_val = np.max(np.abs(oversampled))
        except Exception:
            # Fallback to direct maximum if resample fails
            max_val = np.max(np.abs(data))

        if max_val <= 1e-6:
            return -120.0
        return float(20.0 * np.log10(max_val))

    @classmethod
    def analyze(
        cls,
        file_source: Union[str, Path, io.BytesIO, bytes],
        filename: str = "audio_track"
    ) -> LoudnessTelemetryResponse:
        """
        Analyze audio file for Integrated Loudness (LUFS), Loudness Range (LU),
        and True Peak (dBFS).
        """
        data, sr = cls.load_audio(file_source)
        samples_count, channels = data.shape
        duration_seconds = float(samples_count / sr) if sr > 0 else 0.0

        # 1. Compute True Peak
        true_peak_dbfs = cls.compute_true_peak(data, sr, oversample_factor=4)

        # 2. Compute Integrated Loudness and Loudness Range
        #
        # Integrated loudness comes from pyloudnorm when available (it is
        # validated against the BS.1770 compliance material). Loudness range is
        # always computed here: pyloudnorm exposes no loudness_range function,
        # so the previous call raised AttributeError into a bare except and
        # every track reported an LRA of exactly 0.0.
        if HAS_PYLOUDNORM:
            try:
                integrated_lufs = float(pyln.Meter(sr).integrated_loudness(data))
                if math.isinf(integrated_lufs) or math.isnan(integrated_lufs):
                    integrated_lufs = -70.0
            except Exception:
                integrated_lufs = cls._integrated_loudness(data, sr)
        else:
            integrated_lufs = cls._integrated_loudness(data, sr)

        loudness_range_lu = cls._loudness_range(data, sr)

        # Target compliance checks:
        # Spotify Target: -14 LUFS (tolerance ±1.0 LU)
        # EBU R128 Target: -23 LUFS (tolerance ±1.0 LU)
        is_spotify = abs(integrated_lufs - (-14.0)) <= 1.0
        is_ebu_r128 = abs(integrated_lufs - (-23.0)) <= 1.0

        return LoudnessTelemetryResponse(
            filename=filename,
            integrated_loudness_lufs=round(integrated_lufs, 2),
            loudness_range_lu=round(loudness_range_lu, 2),
            true_peak_dbfs=round(true_peak_dbfs, 2),
            sample_rate=sr,
            channels=channels,
            duration_seconds=round(duration_seconds, 2),
            is_spotify_compliant=is_spotify,
            is_ebu_r128_compliant=is_ebu_r128
        )

    # ------------------------------------------------------------------
    # ITU-R BS.1770-4 K-weighting
    # ------------------------------------------------------------------

    @staticmethod
    def _k_weight(data: np.ndarray, sr: int) -> np.ndarray:
        """
        Apply the two-stage BS.1770 K-weighting filter.

        Stage 1 is a +4 dB high shelf, stage 2 the RLB high pass. Both are
        designed with the RBJ biquad formulas at the signal's own sample rate,
        which is how filters for rates other than 48 kHz are obtained.

        The parameters below are the ones that reproduce the normative 48 kHz
        coefficients in BS.1770-4 Tables 1 and 2 (agreement ~1e-4 on the shelf,
        ~1e-16 on the high-pass denominator). They are not interchangeable with
        other published parameter sets: designing the shelf at 1682 Hz instead
        of 1500 Hz shifts the midband by a quarter of a decibel.

        The previous implementation passed btype='highshelf' to
        scipy.signal.iirfilter, which is not a valid band type — the function
        raised ValueError on every call.
        """
        # --- Stage 1: high shelf, +4 dB, Q = 1/sqrt(2), fc = 1500 Hz
        G, Q, fc = 4.0, 0.7071067811865475, 1500.0
        A = 10.0 ** (G / 40.0)
        w0 = 2.0 * np.pi * fc / sr
        cw, sw = np.cos(w0), np.sin(w0)
        sa = 2.0 * np.sqrt(A) * (sw / (2.0 * Q))

        b_shelf = np.array([
            A * ((A + 1) + (A - 1) * cw + sa),
            -2.0 * A * ((A - 1) + (A + 1) * cw),
            A * ((A + 1) + (A - 1) * cw - sa),
        ])
        a_shelf = np.array([
            (A + 1) - (A - 1) * cw + sa,
            2.0 * ((A - 1) - (A + 1) * cw),
            (A + 1) - (A - 1) * cw - sa,
        ])
        b_shelf = b_shelf / a_shelf[0]
        a_shelf = a_shelf / a_shelf[0]

        # --- Stage 2: RLB high pass, Q = 0.50033, fc = 38.135 Hz.
        # The numerator stays the spec's literal [1, -2, 1] while only the
        # denominator is normalised. Scaling b by a0 as well — or using the RBJ
        # (1+cos w0)/2 numerator — yields a unity-passband filter that sits a
        # constant 0.043 dB below the normative one. That offset cancels in
        # loudness range, which is a difference of percentiles, but it is free
        # to get right here.
        Q2, fc2 = 0.5003270373238773, 38.13547087602444
        w0 = 2.0 * np.pi * fc2 / sr
        cw, sw = np.cos(w0), np.sin(w0)
        alpha = sw / (2.0 * Q2)

        a0 = 1.0 + alpha
        a_hp = np.array([1.0, -2.0 * cw / a0, (1.0 - alpha) / a0])
        b_hp = np.array([1.0, -2.0, 1.0])

        out = np.empty(data.shape, dtype=np.float64)
        for ch in range(data.shape[1]):
            y = signal.lfilter(b_shelf, a_shelf, data[:, ch].astype(np.float64))
            out[:, ch] = signal.lfilter(b_hp, a_hp, y)
        return out

    @staticmethod
    def _block_loudness(filtered: np.ndarray, sr: int, block_s: float, hop_s: float) -> np.ndarray:
        """Loudness of every overlapping block, in LKFS. Channel weights are 1.0
        for L/R/C, which covers mono and stereo."""
        block_len = int(round(block_s * sr))
        hop = max(1, int(round(hop_s * sr)))
        if filtered.shape[0] < block_len:
            return np.empty(0)

        n = 1 + (filtered.shape[0] - block_len) // hop
        # Mean square per block per channel, via a cumulative sum so a long
        # track does not turn into a Python loop over hundreds of thousands of
        # windows.
        sq = filtered ** 2
        csum = np.concatenate([np.zeros((1, sq.shape[1])), np.cumsum(sq, axis=0)])
        starts = np.arange(n) * hop
        ms = (csum[starts + block_len] - csum[starts]) / block_len
        return -0.691 + 10.0 * np.log10(np.sum(ms, axis=1) + 1e-12)

    @classmethod
    def _integrated_loudness(cls, data: np.ndarray, sr: int) -> float:
        """BS.1770-4 gated integrated loudness: 400 ms blocks at 75% overlap,
        absolute gate at -70 LUFS, relative gate 10 LU below the ungated mean."""
        z = cls._block_loudness(cls._k_weight(data, sr), sr, 0.400, 0.100)
        if z.size == 0:
            return -70.0

        above = z[z > -70.0]
        if above.size == 0:
            return -70.0

        mean_pow = np.mean(10.0 ** ((above + 0.691) / 10.0))
        gamma = (-0.691 + 10.0 * np.log10(mean_pow + 1e-12)) - 10.0

        gated = above[above > gamma]
        if gated.size == 0:
            return -70.0

        return float(-0.691 + 10.0 * np.log10(np.mean(10.0 ** ((gated + 0.691) / 10.0)) + 1e-12))

    @classmethod
    def _loudness_range(cls, data: np.ndarray, sr: int) -> float:
        """
        EBU Tech 3342 loudness range.

        Short-term (3 s) loudness on a 1 s grid, gated absolutely at -70 LUFS
        and then relatively at 20 LU below the mean of what survives. LRA is the
        spread between the 10th and 95th percentiles of the remainder.

        Note the relative gate is -20 LU here, not the -10 LU used for
        integrated loudness; they are different measurements.
        """
        if data.shape[0] < int(3.0 * sr):
            return 0.0

        st = cls._block_loudness(cls._k_weight(data, sr), sr, 3.0, 1.0)
        if st.size == 0:
            return 0.0

        above = st[st > -70.0]
        if above.size < 2:
            return 0.0

        mean_pow = np.mean(10.0 ** ((above + 0.691) / 10.0))
        gamma = (-0.691 + 10.0 * np.log10(mean_pow + 1e-12)) - 20.0

        gated = above[above > gamma]
        if gated.size < 2:
            return 0.0

        return float(max(0.0, np.percentile(gated, 95) - np.percentile(gated, 10)))
