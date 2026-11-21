import io
import shutil
import time
import numpy as np
import soundfile as sf
import pytest
from fastapi.testclient import TestClient

from service.main import app, _async_process_stem_extraction
from service.config import config
from service.core.task_queue import job_manager

client = TestClient(app)

def create_synthetic_audio_file() -> bytes:
    """
    Generates a 2-second synthetic multi-instrument stereo audio file in memory.
    """
    sr = 44100
    duration = 2.0
    total_samples = int(sr * duration)
    t = np.linspace(0, duration, total_samples, endpoint=False)

    # Blend multi-frequency components:
    bass_tone = 0.3 * np.sin(2.0 * np.pi * 80.0 * t)     # Low bass
    vocal_tone = 0.3 * np.sin(2.0 * np.pi * 1200.0 * t)  # Mid vocals
    drum_tone = 0.2 * np.sin(2.0 * np.pi * 350.0 * t)   # Low-mid drums
    hi_tone = 0.1 * np.sin(2.0 * np.pi * 6000.0 * t)     # Highs

    mix = bass_tone + vocal_tone + drum_tone + hi_tone
    stereo_mix = np.column_stack((mix, mix)).astype(np.float32)

    buf = io.BytesIO()
    sf.write(buf, stereo_mix, sr, format="WAV", subtype="PCM_16")
    buf.seek(0)
    return buf.read()


def test_health_endpoint():
    response = client.get("/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "healthy"
    assert "device" in data


def test_loudness_endpoint():
    audio_bytes = create_synthetic_audio_file()
    files = {"file": ("mix_track.wav", audio_bytes, "audio/wav")}

    response = client.post("/api/telemetry/loudness", files=files)
    assert response.status_code == 200
    data = response.json()

    assert data["filename"] == "mix_track.wav"
    assert "integrated_loudness_lufs" in data
    assert "loudness_range_lu" in data
    assert "true_peak_dbfs" in data
    assert data["sample_rate"] == 44100
    assert data["channels"] == 2
    assert data["duration_seconds"] >= 1.9


def test_stem_extraction_lifecycle():
    audio_bytes = create_synthetic_audio_file()
    files = {"file": ("production_track.wav", audio_bytes, "audio/wav")}

    # 1. Initiate extraction
    response = client.post("/api/stems/extract", files=files)
    assert response.status_code == 202
    init_data = response.json()
    job_id = init_data["job_id"]
    assert init_data["status"] == "queued"

    # In TestClient, BackgroundTasks run during the request or synchronously
    # Let's poll status
    max_wait = 15.0
    start_time = time.time()
    final_status = None

    while time.time() - start_time < max_wait:
        poll_resp = client.get(f"/api/stems/status/{job_id}")
        assert poll_resp.status_code == 200
        poll_data = poll_resp.json()
        if poll_data["status"] in ["completed", "failed"]:
            final_status = poll_data
            break
        time.sleep(0.5)

    assert final_status is not None, "Job timed out before reaching completion or failure."
    assert final_status["status"] == "completed", f"Job failed with error: {final_status.get('error_message')}"
    assert final_status["progress"] == 100

    # 2. Verify all 4 stems, HTTP stem_urls, and track loudness telemetry
    stems = final_status["stems"]
    assert set(stems.keys()) == {"drums", "bass", "vocals", "other"}

    stem_urls = final_status["stem_urls"]
    assert set(stem_urls.keys()) == {"drums", "bass", "vocals", "other"}
    assert final_status["filename"] == "production_track.wav"
    assert final_status["loudness"] is not None
    assert "integrated_loudness_lufs" in final_status["loudness"]

    stem_details = final_status["stem_details"]
    sample_counts = []

    try:
        for name in ["drums", "bass", "vocals", "other"]:
            info = stem_details[name]
            assert info["sample_rate"] == 48000
            assert info["url"] == stem_urls[name]
            sample_counts.append(info["sample_count"])

            # Read generated file on disk
            stem_path = info["file_path"]
            data, sr = sf.read(stem_path)
            assert sr == 48000
            assert data.shape[1] == 2  # Stereo

            # Verify HTTP streaming endpoint returns valid 48kHz stereo WAV bytes
            dl_resp = client.get(stem_urls[name])
            assert dl_resp.status_code == 200
            assert dl_resp.headers["content-type"].startswith("audio/wav")
            dl_data, dl_sr = sf.read(io.BytesIO(dl_resp.content))
            assert dl_sr == 48000
            assert dl_data.shape == data.shape

        # 3. Assert sample-accurate length alignment across all 4 stems
        assert len(set(sample_counts)) == 1, f"Mismatch in sample lengths: {sample_counts}"

        # 4. Verify session listing exposes the completed session
        sessions_resp = client.get("/api/stems/sessions")
        assert sessions_resp.status_code == 200
        session_ids = [s["job_id"] for s in sessions_resp.json()["sessions"]]
        assert job_id in session_ids
    finally:
        shutil.rmtree(config.SESSIONS_DIR / job_id, ignore_errors=True)


def test_stem_download_validation():
    bad_job = client.get("/api/stems/files/..invalid/drums.wav")
    assert bad_job.status_code == 400

    bad_stem = client.get(f"/api/stems/files/{'a' * 32}/malicious.wav")
    assert bad_stem.status_code == 404

    missing_job = client.get(f"/api/stems/files/{'0' * 32}/drums.wav")
    assert missing_job.status_code == 404


def test_invalid_extension():
    fake_content = b"not an audio file"
    files = {"file": ("malicious.exe", fake_content, "application/octet-stream")}
    response = client.post("/api/stems/extract", files=files)
    assert response.status_code == 400
    assert "Unsupported file format" in response.json()["detail"]


def test_nonexistent_job_status():
    response = client.get("/api/stems/status/non_existent_job_12345")
    assert response.status_code == 404
    assert "not found" in response.json()["detail"]


if __name__ == "__main__":
    test_health_endpoint()
    test_loudness_endpoint()
    test_stem_extraction_lifecycle()
    test_invalid_extension()
    test_nonexistent_job_status()
    print("All API integration tests passed successfully!")
