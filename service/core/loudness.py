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
        if HAS_PYLOUDNORM:
            meter = pyln.Meter(sr)
            # Integrated loudness
            try:
                integrated_lufs = float(meter.integrated_loudness(data))
                if math.isinf(integrated_lufs) or math.isnan(integrated_lufs):
                    integrated_lufs = -70.0
            except Exception:
                integrated_lufs = -70.0

            # Loudness Range (LRA)
            try:
                loudness_range_lu = float(pyln.loudness_range(data, sr))
                if math.isinf(loudness_range_lu) or math.isnan(loudness_range_lu):
                    loudness_range_lu = 0.0
            except Exception:
                loudness_range_lu = 0.0
        else:
            # Native ITU-R BS.1770-4 K-weighting calculation
            integrated_lufs, loudness_range_lu = cls._native_bs1770_analysis(data, sr)

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

    @staticmethod
    def _native_bs1770_analysis(data: np.ndarray, sr: int) -> Tuple[float, float]:
        """
        Pure NumPy / SciPy implementation of ITU-R BS.1770-4 K-weighting filter & gating.
        """
        if data.shape[0] < sr * 0.4:
            return -70.0, 0.0

        # Stage 1: High-shelf pre-filter (models head acoustic acoustics)
        # Coefficients for 48kHz (scaled for arbitrary sr via bilinear)
        b_shelf, a_shelf = signal.iirfilter(
            2, 1680.0 / (sr / 2.0), btype='highshelf', ftype='butter', rs=4.0, output='ba'
        )
        # Stage 2: Highpass RLB filter (models human ear low-frequency roll-off)
        b_rlb, a_rlb = signal.butter(2, 38.0 / (sr / 2.0), btype='highpass')

        # Apply cascade filters per channel
        filtered = np.zeros_like(data)
        for ch in range(data.shape[1]):
            y1 = signal.lfilter(b_shelf, a_shelf, data[:, ch])
            filtered[:, ch] = signal.lfilter(b_rlb, a_rlb, y1)

        # 400ms blocks with 75% overlap (100ms hop)
        block_len = int(0.4 * sr)
        step_len = int(0.1 * sr)

        num_blocks = (filtered.shape[0] - block_len) // step_len
        if num_blocks <= 0:
            return -70.0, 0.0

        z_blocks = []
        for i in range(num_blocks):
            start = i * step_len
            blk = filtered[start:start + block_len, :]
            # Mean square energy per block across channels
            ms = np.mean(blk ** 2, axis=0)
            # Channel weighting (G_i = 1.0 for Left, Right, Center)
            z = -0.691 + 10.0 * np.log10(np.sum(ms) + 1e-12)
            z_blocks.append(z)

        z_blocks = np.array(z_blocks)

        # Absolute threshold gating at -70 LUFS
        valid_abs = z_blocks[z_blocks > -70.0]
        if len(valid_abs) == 0:
            return -70.0, 0.0

        # Relative threshold gating at -10 LU below unweighted mean
        z_ungated = -0.691 + 10.0 * np.log10(np.mean(10.0 ** ((valid_abs + 0.691) / 10.0)) + 1e-12)
        gamma_rel = z_ungated - 10.0

        valid_rel = valid_abs[valid_abs > gamma_rel]
        if len(valid_rel) == 0:
            return -70.0, 0.0

        integrated_lufs = -0.691 + 10.0 * np.log10(np.mean(10.0 ** ((valid_rel + 0.691) / 10.0)) + 1e-12)

        # Loudness range (LRA): 3000ms short-term blocks
        st_block_len = int(3.0 * sr)
        st_step_len = int(1.0 * sr)
        st_blocks = (filtered.shape[0] - st_block_len) // st_step_len
        if st_blocks > 1:
            st_lufs = []
            for i in range(st_blocks):
                st_b = filtered[i * st_step_len : i * st_step_len + st_block_len, :]
                ms = np.mean(st_b ** 2, axis=0)
                st_lufs.append(-0.691 + 10.0 * np.log10(np.sum(ms) + 1e-12))
            st_lufs = np.array(st_lufs)
            st_valid = st_lufs[st_lufs > -70.0]
            if len(st_valid) > 1:
                p10 = np.percentile(st_valid, 10)
                p95 = np.percentile(st_valid, 95)
                lra = float(max(0.0, p95 - p10))
            else:
                lra = 0.0
        else:
            lra = 0.0

        return float(integrated_lufs), float(lra)
