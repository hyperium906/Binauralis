import os
from pathlib import Path
from dataclasses import dataclass, field

@dataclass
class ServiceConfig:
    APP_NAME: str = "AuraStream Audio Ingestion & Telemetry Service"
    VERSION: str = "1.0.0"
    DEBUG: bool = False

    # Directory Paths
    BASE_DIR: Path = Path(__file__).resolve().parent.parent
    STORAGE_DIR: Path = BASE_DIR / "storage"
    UPLOADS_DIR: Path = STORAGE_DIR / "uploads"
    SESSIONS_DIR: Path = STORAGE_DIR / "sessions"

    # Audio Production Standards
    TARGET_SAMPLE_RATE: int = 48000
    TARGET_BIT_DEPTH: int = 16  # 16-bit PCM WAV
    TARGET_CHANNELS: int = 2     # Stereo

    # Demucs Separation Configuration
    DEMUCS_MODEL: str = "htdemucs"
    STEMS: list[str] = field(default_factory=lambda: ["drums", "bass", "vocals", "other"])
    
    # Allowed Formats & Limits
    ALLOWED_EXTENSIONS: set[str] = field(
        default_factory=lambda: {".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aiff"}
    )
    MAX_FILE_SIZE_MB: int = 250

    def init_dirs(self) -> None:
        self.UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
        self.SESSIONS_DIR.mkdir(parents=True, exist_ok=True)

config = ServiceConfig()
config.init_dirs()
