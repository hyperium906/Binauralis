import uuid
import shutil
import logging
from pathlib import Path
from contextlib import asynccontextmanager
from fastapi import FastAPI, UploadFile, File, BackgroundTasks, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from service.config import config
from service.models.schemas import (
    StemExtractionInitiateResponse,
    StemExtractionStatusResponse,
    LoudnessTelemetryResponse,
    JobStatus
)
from service.core.task_queue import job_manager
from service.core.stem_separator import stem_separator
from service.core.loudness import LoudnessTelemetryAnalyzer

# Setup structured logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
logger = logging.getLogger("aurastream.service")

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


def _async_process_stem_extraction(job_id: str, input_path: Path, session_dir: Path):
    """
    Background worker function executed off the main asyncio event loop.
    """
    try:
        def on_progress(p: int):
            job_manager.update_progress(job_id, p, status=JobStatus.PROCESSING)

        # Run stem separation pipeline
        results = stem_separator.separate(
            audio_path=input_path,
            session_dir=session_dir,
            progress_callback=on_progress
        )

        stems_dict = {name: info.file_path for name, info in results.items()}
        job_manager.mark_completed(
            job_id=job_id,
            session_dir=str(session_dir.resolve()),
            stems=stems_dict,
            stem_details=results
        )
        logger.info(f"Job {job_id} successfully completed.")
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
        "device": str(stem_separator.device)
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
    filename = file.filename or "audio_upload"
    ext = Path(filename).suffix.lower()

    if ext not in config.ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unsupported file format '{ext}'. Allowed formats: {', '.join(sorted(config.ALLOWED_EXTENSIONS))}"
        )

    job_id = uuid.uuid4().hex
    input_path = config.UPLOADS_DIR / f"{job_id}{ext}"
    session_dir = config.SESSIONS_DIR / job_id

    # Stream upload file to disk staging area
    try:
        with open(input_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to save upload stream: {e}"
        )

    # Register job in asynchronous queue tracker
    job_manager.register_job(job_id)

    # Enqueue background separation task
    background_tasks.add_task(
        _async_process_stem_extraction,
        job_id=job_id,
        input_path=input_path,
        session_dir=session_dir
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
