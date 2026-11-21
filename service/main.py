import uuid
import logging
from pathlib import Path
from contextlib import asynccontextmanager
from fastapi import FastAPI, UploadFile, File, BackgroundTasks, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from service.config import config
from service.models.schemas import (
    StemExtractionInitiateResponse,
    StemExtractionStatusResponse,
    LoudnessTelemetryResponse,
    SessionListResponse,
    JobStatus
)
from service.core.task_queue import JOB_ID_PATTERN, job_manager
from service.core.stem_separator import stem_separator
from service.core.loudness import LoudnessTelemetryAnalyzer

# Setup structured logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
logger = logging.getLogger("aurastream.service")

VALID_STEMS = frozenset(config.STEMS)
UPLOAD_CHUNK_BYTES = 1024 * 1024  # 1 MiB


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: ensure storage directories exist
    config.init_dirs()
    logger.info(f"{config.APP_NAME} v{config.VERSION} initialized.")
    yield
    # Shutdown
    logger.info("Service shutting down.")

app = FastAPI(
    title=config.APP_NAME,
    version=config.VERSION,
    description="Production-ready FastAPI audio ingestion, Demucs stem separation, and ITU-R BS.1770-4 telemetry.",
    lifespan=lifespan
)

# Enable CORS for browser / AudioWorklet clients
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _async_process_stem_extraction(
    job_id: str,
    input_path: Path,
    session_dir: Path,
    original_filename: str = "audio_upload",
):
    """
    Background worker function executed off the main asyncio event loop.
    Runs ITU-R BS.1770-4 loudness analysis alongside 4-stem separation and
    exposes browser-fetchable HTTP URLs for each aligned 48kHz WAV stem.
    """
    try:
        def on_progress(p: int):
            job_manager.update_progress(job_id, p, status=JobStatus.PROCESSING)

        # Compute broadcast loudness telemetry on the original upload before cleanup
        loudness_telemetry = None
        try:
            loudness_telemetry = LoudnessTelemetryAnalyzer.analyze(
                input_path,
                filename=original_filename,
            )
        except Exception as loudness_err:
            logger.warning(f"Loudness telemetry skipped for job {job_id}: {loudness_err}")

        # Run stem separation pipeline
        results = stem_separator.separate(
            audio_path=input_path,
            session_dir=session_dir,
            progress_callback=on_progress
        )

        stems_dict = {}
        stem_urls = {}
        for name, info in results.items():
            url = f"/api/stems/files/{job_id}/{name}.wav"
            info.url = url
            stems_dict[name] = info.file_path
            stem_urls[name] = url

        job_manager.mark_completed(
            job_id=job_id,
            session_dir=str(session_dir.resolve()),
            stems=stems_dict,
            stem_urls=stem_urls,
            stem_details=results,
            loudness=loudness_telemetry,
            separation_engine=stem_separator.last_engine_used,
        )
        logger.info(f"Job {job_id} successfully completed ({stem_separator.last_engine_used}).")
    except Exception as e:
        logger.exception(f"Error processing job {job_id}: {e}")
        job_manager.mark_failed(job_id, str(e))
    finally:
        # Clean up temporary upload file
        if input_path.exists():
            try:
                input_path.unlink()
            except Exception:
                pass


@app.get("/health", tags=["Health"])
async def health_check():
    return {
        "status": "healthy",
        "service": config.APP_NAME,
        "version": config.VERSION,
        "device": str(stem_separator.device),
        "sample_rate": config.TARGET_SAMPLE_RATE,
    }


@app.post(
    "/api/stems/extract",
    response_model=StemExtractionInitiateResponse,
    status_code=status.HTTP_202_ACCEPTED,
    tags=["Stems"]
)
async def extract_stems(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...)
):
    """
    Accepts an uploaded audio file (.wav, .mp3, .flac, etc.) and enqueues Demucs 4-stem separation.
    Returns 202 Accepted with a unique job_id for asynchronous status polling.
    """
    filename = Path(file.filename or "audio_upload").name
    ext = Path(filename).suffix.lower()

    if ext not in config.ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unsupported file format '{ext}'. Allowed formats: {', '.join(sorted(config.ALLOWED_EXTENSIONS))}"
        )

    job_id = uuid.uuid4().hex
    input_path = config.UPLOADS_DIR / f"{job_id}{ext}"
    session_dir = config.SESSIONS_DIR / job_id
    max_bytes = config.MAX_FILE_SIZE_MB * 1024 * 1024

    # Stream upload file to disk staging area with size guard
    total_written = 0
    try:
        with open(input_path, "wb") as buffer:
            while True:
                chunk = await file.read(UPLOAD_CHUNK_BYTES)
                if not chunk:
                    break
                total_written += len(chunk)
                if total_written > max_bytes:
                    raise HTTPException(
                        status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                        detail=f"Uploaded file exceeds {config.MAX_FILE_SIZE_MB} MB limit."
                    )
                buffer.write(chunk)
        if total_written == 0:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Uploaded audio file is empty."
            )
    except HTTPException:
        if input_path.exists():
            input_path.unlink(missing_ok=True)
        raise
    except Exception as e:
        if input_path.exists():
            input_path.unlink(missing_ok=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to save upload stream: {e}"
        )

    # Register job in asynchronous queue tracker
    job_manager.register_job(job_id, filename=filename)

    # Enqueue background separation task
    background_tasks.add_task(
        _async_process_stem_extraction,
        job_id=job_id,
        input_path=input_path,
        session_dir=session_dir,
        original_filename=filename,
    )

    return StemExtractionInitiateResponse(
        job_id=job_id,
        status=JobStatus.QUEUED,
        message="Stem separation task queued successfully."
    )


@app.get(
    "/api/stems/status/{job_id}",
    response_model=StemExtractionStatusResponse,
    tags=["Stems"]
)
async def get_stem_extraction_status(job_id: str):
    """
    Polls the real-time lifecycle status and progress of an asynchronous stem extraction job.
    """
    status_response = job_manager.get_status(job_id)
    if not status_response:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Job '{job_id}' not found."
        )
    return status_response


@app.get(
    "/api/stems/sessions",
    response_model=SessionListResponse,
    tags=["Stems"]
)
async def list_stem_sessions():
    """
    Lists previously completed 4-stem separation sessions available on disk.
    """
    return SessionListResponse(sessions=job_manager.list_sessions())


@app.get(
    "/api/stems/files/{job_id}/{stem_name}.wav",
    tags=["Stems"]
)
async def download_stem_wav(job_id: str, stem_name: str):
    """
    Streams an extracted 16-bit 48kHz PCM WAV stem to browser Web Audio clients.
    """
    if not JOB_ID_PATTERN.match(job_id):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid session identifier."
        )
    if stem_name not in VALID_STEMS:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Unknown stem '{stem_name}'."
        )

    sessions_root = config.SESSIONS_DIR.resolve()
    stem_path = (sessions_root / job_id / f"{stem_name}.wav").resolve()
    if sessions_root not in stem_path.parents or not stem_path.is_file():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Stem '{stem_name}' for session '{job_id}' not found."
        )

    return FileResponse(
        path=stem_path,
        media_type="audio/wav",
        filename=f"{job_id}_{stem_name}.wav",
        headers={"Cache-Control": "public, max-age=3600"},
    )


@app.post(
    "/api/telemetry/loudness",
    response_model=LoudnessTelemetryResponse,
    tags=["Telemetry"]
)
async def analyze_loudness(
    file: UploadFile = File(...)
):
    """
    Analyzes an audio file conforming to ITU-R BS.1770-4 and EBU R128 standards.
    Returns Integrated Loudness (LUFS), Loudness Range (LU), and True Peak (dBFS).
    """
    filename = file.filename or "audio_track"
    try:
        content = await file.read()
        if len(content) == 0:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Uploaded file is empty."
            )
        telemetry = LoudnessTelemetryAnalyzer.analyze(content, filename=filename)
        return telemetry
    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"Loudness analysis error: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to analyze audio loudness: {str(e)}"
        )
