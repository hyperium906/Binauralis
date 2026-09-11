from enum import Enum
from datetime import datetime, timezone
from typing import Optional, Dict
from pydantic import BaseModel, Field

class JobStatus(str, Enum):
    QUEUED = "queued"
    PROCESSING = "processing"
    COMPLETED = "completed"
    FAILED = "failed"

class StemFileInfo(BaseModel):
    name: str = Field(..., description="Stem name: drums, bass, vocals, or other")
    file_path: str = Field(..., description="Absolute path on disk to 16-bit 48kHz WAV")
    sample_rate: int = Field(48000, description="Sampling rate in Hz")
    duration_seconds: float = Field(..., description="Duration in seconds")
    sample_count: int = Field(..., description="Exact sample count for phase verification")
    file_size_bytes: int = Field(..., description="Size in bytes on disk")

class StemExtractionInitiateResponse(BaseModel):
    job_id: str = Field(..., description="Unique job identifier")
    status: JobStatus = Field(JobStatus.QUEUED, description="Initial job state")
    message: str = Field(..., description="Human-readable status summary")
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

class StemExtractionStatusResponse(BaseModel):
    job_id: str
    status: JobStatus
    progress: int = Field(..., ge=0, le=100, description="Progress percentage 0-100%")
    created_at: datetime
    updated_at: datetime
    session_dir: Optional[str] = None
    stems: Optional[Dict[str, str]] = None
    stem_details: Optional[Dict[str, StemFileInfo]] = None
    error_message: Optional[str] = None

class LoudnessTelemetryResponse(BaseModel):
    filename: str
    integrated_loudness_lufs: float = Field(..., description="Integrated Loudness conforming to ITU-R BS.1770-4")
    loudness_range_lu: float = Field(..., description="Loudness Range (LRA) in Loudness Units (LU)")
    true_peak_dbfs: float = Field(..., description="True Peak level in dBFS (4x oversampled)")
    sample_rate: int = Field(..., description="Audio sample rate in Hz")
    channels: int = Field(..., description="Number of audio channels")
    duration_seconds: float = Field(..., description="Audio duration in seconds")
    is_spotify_compliant: bool = Field(..., description="True if Integrated Loudness is within -14 LUFS ± 1 LU")
    is_ebu_r128_compliant: bool = Field(..., description="True if Integrated Loudness is within -23 LUFS ± 1 LU")
