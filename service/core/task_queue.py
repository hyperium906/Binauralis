import threading
from datetime import datetime, timezone
from typing import Dict, Optional
from service.models.schemas import JobStatus, StemExtractionStatusResponse, StemFileInfo

class TaskQueueManager:
    """
    Thread-safe in-memory job manager and status tracker for asynchronous audio tasks.
    """
    def __init__(self):
        self._lock = threading.Lock()
        self._jobs: Dict[str, StemExtractionStatusResponse] = {}

    def register_job(self, job_id: str) -> StemExtractionStatusResponse:
        now = datetime.now(timezone.utc)
        response = StemExtractionStatusResponse(
            job_id=job_id,
            status=JobStatus.QUEUED,
            progress=0,
            created_at=now,
            updated_at=now
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
        stem_details: Dict[str, StemFileInfo]
    ) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job:
                job.status = JobStatus.COMPLETED
                job.progress = 100
                job.session_dir = session_dir
                job.stems = stems
                job.stem_details = stem_details
                job.updated_at = datetime.now(timezone.utc)

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
                # Return a copy
                return job.model_copy()
            return None

job_manager = TaskQueueManager()
