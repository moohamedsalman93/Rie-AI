"""
Speaker Verification Endpoints for Rie-AI.
Provides fast offline speaker verification API for live microphone gating.
"""

import io
import wave
import base64
import logging
from typing import Optional, Dict, Any, List
import numpy as np
from fastapi import APIRouter, Request, HTTPException, Depends
from pydantic import BaseModel, Field

from app.security import verify_app_token
from speaker_id.service import speaker_verification_service
from speaker_id.enroll import enroll_speaker_from_arrays

logger = logging.getLogger("speaker_routes")

router = APIRouter(prefix="/api/speaker", tags=["speaker_id"])


class VerifyAudioPayload(BaseModel):
    """Payload for base64-encoded PCM or WAV audio verification."""
    audio: str = Field(..., description="Base64-encoded 16-bit linear PCM little-endian or WAV audio")
    sample_rate: int = Field(default=16000, description="Sampling rate in Hz (default 16000)")
    sample_width: int = Field(default=2, description="Bytes per sample (2 for 16-bit PCM)")


class EnrollAudioPayload(BaseModel):
    """Payload for enrolling voice samples."""
    samples: List[str] = Field(..., description="List of base64-encoded PCM or WAV audio samples")
    speaker_name: str = Field(default="USER", description="Speaker name (default: USER)")
    sample_rate: int = Field(default=16000, description="Sampling rate in Hz (default 16000)")
    sample_width: int = Field(default=2, description="Bytes per sample (default: 2 for 16-bit PCM)")


class ThresholdsPayload(BaseModel):
    user_threshold: Optional[float] = Field(None, ge=0.0, le=1.0)
    unknown_threshold: Optional[float] = Field(None, ge=0.0, le=1.0)


@router.post("/verify")
async def verify_speaker(
    request: Request,
    _auth=Depends(verify_app_token),
) -> Dict[str, Any]:
    """
    Verifies an audio buffer against the enrolled speaker profile.
    Accepts either:
      1. JSON with base64 'audio' string: {"audio": "...", "sample_rate": 16000}
      2. Raw binary PCM stream via Content-Type: application/octet-stream
    Returns 3-state decision: USER (allow), UNKNOWN (wait/discard), OTHER (discard).
    """
    content_type = request.headers.get("content-type", "")

    try:
        if "application/octet-stream" in content_type:
            # High-performance raw binary stream
            pcm_bytes = await request.body()
            if not pcm_bytes:
                raise HTTPException(status_code=400, detail="Empty binary PCM body")
            sample_rate = int(request.headers.get("x-sample-rate", "16000"))
            return speaker_verification_service.verify_pcm_bytes(pcm_bytes, sample_rate=sample_rate)

        # JSON body (base64 PCM or WAV)
        body = await request.json()
        audio_data = body.get("audio")
        if not audio_data:
            raise HTTPException(status_code=400, detail="Missing 'audio' field in JSON payload")
        sample_rate = int(body.get("sample_rate", 16000))
        sample_width = int(body.get("sample_width", 2))
        return speaker_verification_service.verify_base64_pcm(
            audio_data,
            sample_rate=sample_rate,
            sample_width=sample_width,
        )

    except FileNotFoundError as fnf:
        logger.error(f"[SpeakerAPI] Profile error: {fnf}")
        raise HTTPException(status_code=404, detail=str(fnf))
    except ValueError as val_err:
        logger.warning(f"[SpeakerAPI] Validation error: {val_err}")
        raise HTTPException(status_code=422, detail=str(val_err))
    except Exception as exc:
        logger.exception(f"[SpeakerAPI] Internal error: {exc}")
        raise HTTPException(status_code=500, detail=f"Speaker verification failed: {exc}")


@router.get("/status")
async def get_speaker_status(_auth=Depends(verify_app_token)) -> Dict[str, Any]:
    """Returns readiness and threshold configuration of the speaker verification engine."""
    return speaker_verification_service.get_status()


@router.get("/profile")
async def get_speaker_profile(_auth=Depends(verify_app_token)) -> Dict[str, Any]:
    """Returns enrolled profile metadata."""
    return speaker_verification_service.get_profile_info()


@router.post("/thresholds")
async def update_thresholds(
    payload: ThresholdsPayload,
    _auth=Depends(verify_app_token),
) -> Dict[str, Any]:
    """Dynamically updates decision gate thresholds."""
    if payload.user_threshold is not None:
        speaker_verification_service.user_threshold = payload.user_threshold
    if payload.unknown_threshold is not None:
        speaker_verification_service.unknown_threshold = payload.unknown_threshold

    return {
        "status": "updated",
        "thresholds": {
            "user": speaker_verification_service.user_threshold,
            "unknown": speaker_verification_service.unknown_threshold,
        },
    }


@router.post("/enroll")
async def enroll_speaker_profile(
    payload: EnrollAudioPayload,
    _auth=Depends(verify_app_token),
) -> Dict[str, Any]:
    """
    Enrolls a new voice profile from 1 or more audio samples.
    Computes CAM++ embeddings, saves profile to disk, and immediately activates it in RAM.
    """
    if not payload.samples:
        raise HTTPException(status_code=400, detail="At least one audio sample is required for enrollment.")

    audio_data_list = []
    for idx, raw_b64 in enumerate(payload.samples):
        try:
            raw_bytes = base64.b64decode(raw_b64)
            if raw_bytes.startswith(b"RIFF"):
                with io.BytesIO(raw_bytes) as bio:
                    with wave.open(bio, "rb") as wf:
                        sr = wf.getframerate()
                        sw = wf.getsampwidth()
                        frames = wf.readframes(wf.getnframes())
                        if sw == 2:
                            samples = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
                        elif sw == 4:
                            samples = np.frombuffer(frames, dtype=np.float32)
                        else:
                            samples = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
                        audio_data_list.append((samples, sr))
            else:
                if payload.sample_width == 2:
                    samples = np.frombuffer(raw_bytes, dtype=np.int16).astype(np.float32) / 32768.0
                elif payload.sample_width == 4:
                    samples = np.frombuffer(raw_bytes, dtype=np.float32)
                else:
                    samples = np.frombuffer(raw_bytes, dtype=np.int16).astype(np.float32) / 32768.0
                audio_data_list.append((samples, payload.sample_rate))
        except Exception as e:
            logger.warning(f"[SpeakerAPI] Could not decode sample {idx+1}: {e}")

    if not audio_data_list:
        raise HTTPException(status_code=400, detail="Could not decode any valid audio samples from payload.")

    try:
        res = enroll_speaker_from_arrays(
            audio_data_list=audio_data_list,
            profile_path=speaker_verification_service.profile_path,
            speaker_name=payload.speaker_name or "USER",
            save_to_samples_dir=False,
        )
        speaker_verification_service.ensure_profile_loaded(force_reload=True)

        avg_align = res.get("avg_alignment", 0.0)
        quality = "EXCELLENT" if avg_align >= 0.80 else ("GOOD" if avg_align >= 0.65 else "FAIR")

        return {
            "status": "success",
            "enrolled": True,
            "speaker": res.get("speaker", "USER"),
            "num_samples": res.get("num_samples", len(audio_data_list)),
            "avg_alignment": avg_align,
            "quality": quality,
            "intra_similarity": res.get("intra_similarity", []),
            "created_at": res.get("created_at"),
            "message": "Voice profile successfully enrolled and activated.",
        }
    except Exception as exc:
        logger.exception(f"[SpeakerAPI] Enrollment failed: {exc}")
        raise HTTPException(status_code=500, detail=f"Enrollment failed: {exc}")


@router.delete("/profile")
async def delete_speaker_profile(_auth=Depends(verify_app_token)) -> Dict[str, Any]:
    """Deletes the enrolled voice profile from disk and clears it from RAM."""
    deleted = speaker_verification_service.reset_profile()
    return {
        "status": "deleted" if deleted else "not_found",
        "enrolled": False,
        "message": "Voice profile removed." if deleted else "No voice profile to delete.",
    }
