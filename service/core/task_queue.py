import json
import re
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional
import soundfile as sf

from service.config import config
from service.models.schemas import (
    JobStatus,
    LoudnessTelemetryResponse,
    SessionSummary,
    StemExtractionStatusResponse,
    StemFileInfo,
)

JOB_ID_PATTERN = re.compile(r"^[0-9a-f]{32}$")
METADATA_FILENAME = "metadata.json"


class TaskQueueManager:
    """
    Thread-safe job manager and status tracker for asynchronous audio tasks,
    backed by per-session metadata.json files so separated sessions remain
    discoverable across service restarts.
    """
    def __init__(self):
        self._lock = threading.Lock()
        self._jobs: Dict[str, StemExtractionStatusResponse] = {}

    def register_job(self, job_id: str, filename: Optional[str] = None) -> StemExtractionStatusResponse:
        now = datetime.now(timezone.utc)
        response = StemExtractionStatusResponse(
            job_id=job_id,
            status=JobStatus.QUEUED,
            progress=0,
            created_at=now,
            updated_at=now,
            filename=filename,
        )
        with self._lock:
            self._jobs[job_id] = response
        return response

    def update_progress(self, job_id: str, progress: int, status: JobStatus = JobStatus.PROCESSING) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job:
                job.progress = max(0, min(100, progress))
                job.status = status
                job.updated_at = datetime.now(timezone.utc)

    def mark_completed(
        self,
        job_id: str,
        session_dir: str,
        stems: Dict[str, str],
        stem_details: Dict[str, StemFileInfo],
        stem_urls: Optional[Dict[str, str]] = None,
        loudness: Optional[LoudnessTelemetryResponse] = None,
        separation_engine: Optional[str] = None,
    ) -> None:
        snapshot: Optional[StemExtractionStatusResponse] = None
        with self._lock:
            job = self._jobs.get(job_id)
            if job:
                job.status = JobStatus.COMPLETED
                job.progress = 100
                job.session_dir = session_dir
                job.stems = stems
                job.stem_urls = stem_urls
                job.stem_details = stem_details
                job.loudness = loudness
                job.separation_engine = separation_engine
                job.updated_at = datetime.now(timezone.utc)
                snapshot = job.model_copy()

        if snapshot is not None:
            meta_path = Path(session_dir) / METADATA_FILENAME
            try:
                meta_path.write_text(snapshot.model_dump_json(indent=2), encoding="utf-8")
            except OSError:
                pass

    def mark_failed(self, job_id: str, error_msg: str) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job:
                job.status = JobStatus.FAILED
                job.error_message = error_msg
                job.updated_at = datetime.now(timezone.utc)

    def get_status(self, job_id: str) -> Optional[StemExtractionStatusResponse]:
        with self._lock:
            job = self._jobs.get(job_id)
            if job:
                return job.model_copy()

        return self._load_session_from_disk(job_id)

    def _load_session_from_disk(self, job_id: str) -> Optional[StemExtractionStatusResponse]:
        if not JOB_ID_PATTERN.match(job_id):
            return None

        session_dir = config.SESSIONS_DIR / job_id
        if not session_dir.is_dir():
            return None

        meta_path = session_dir / METADATA_FILENAME
        if meta_path.is_file():
            try:
                raw = json.loads(meta_path.read_text(encoding="utf-8"))
                return StemExtractionStatusResponse.model_validate(raw)
            except Exception:
                pass

        # Fallback: reconstruct metadata if all 4 aligned stem WAVs exist on disk
        required = tuple(config.STEMS)
        stem_files = {name: session_dir / f"{name}.wav" for name in required}
        if not all(path.is_file() for path in stem_files.values()):
            return None

        stems: Dict[str, str] = {}
        stem_urls: Dict[str, str] = {}
        stem_details: Dict[str, StemFileInfo] = {}
        newest_mtime = 0.0

        for name, path in stem_files.items():
            try:
                info = sf.info(str(path))
            except Exception:
                return None
            stat = path.stat()
            newest_mtime = max(newest_mtime, stat.st_mtime)
            url = f"/api/stems/files/{job_id}/{name}.wav"
            stems[name] = str(path.resolve())
            stem_urls[name] = url
            stem_details[name] = StemFileInfo(
                name=name,
                file_path=str(path.resolve()),
                url=url,
                sample_rate=info.samplerate,
                duration_seconds=round(info.frames / max(1, info.samplerate), 3),
                sample_count=info.frames,
                file_size_bytes=stat.st_size,
            )

        ts = datetime.fromtimestamp(newest_mtime, tz=timezone.utc)
        return StemExtractionStatusResponse(
            job_id=job_id,
            status=JobStatus.COMPLETED,
            progress=100,
            created_at=ts,
            updated_at=ts,
            filename=f"Session {job_id[:8]}",
            session_dir=str(session_dir.resolve()),
            stems=stems,
            stem_urls=stem_urls,
            stem_details=stem_details,
        )

    def list_sessions(self, limit: int = 20) -> List[SessionSummary]:
        if not config.SESSIONS_DIR.is_dir():
            return []

        summaries: List[SessionSummary] = []
        for entry in config.SESSIONS_DIR.iterdir():
            if not entry.is_dir() or not JOB_ID_PATTERN.match(entry.name):
                continue
            status_obj = self._load_session_from_disk(entry.name)
            if not status_obj or status_obj.status != JobStatus.COMPLETED:
                continue
            if not status_obj.stem_urls or not status_obj.stem_details:
                continue

            first_stem = next(iter(status_obj.stem_details.values()))
            summaries.append(
                SessionSummary(
                    job_id=status_obj.job_id,
                    filename=status_obj.filename or f"Session {status_obj.job_id[:8]}",
                    created_at=status_obj.created_at,
                    duration_seconds=first_stem.duration_seconds,
                    sample_rate=first_stem.sample_rate,
                    separation_engine=status_obj.separation_engine,
                    stem_urls=status_obj.stem_urls,
                    loudness=status_obj.loudness,
                )
            )

        summaries.sort(key=lambda item: item.created_at, reverse=True)
        return summaries[:limit]


job_manager = TaskQueueManager()
