"""
Speaker Verification Service for Rie-AI.
In-memory cached singleton for Sherpa-ONNX speaker verification.
Implements the 3-state decision gate:
  - Score >= 0.55        -> USER (ALLOW)
  - 0.35 <= Score < 0.55 -> UNKNOWN (WAIT / ACCUMULATE EVIDENCE)
  - Score < 0.35         -> OTHER (DISCARD)
"""

import time
import base64
import logging
from pathlib import Path
from typing import Optional, Tuple, Dict, Any
import numpy as np

from .model import SpeakerModel, cosine_similarity
from .verify import load_profile, DEFAULT_PROFILE_PATH

logger = logging.getLogger("speaker_verification")

DEFAULT_USER_THRESHOLD = 0.50
DEFAULT_UNKNOWN_THRESHOLD = 0.32


class SpeakerVerificationService:
    """
    In-memory speaker verification service.
    Caches the ONNX model and enrolled profile to provide sub-50ms CPU verification.
    """

    _instance: Optional["SpeakerVerificationService"] = None

    def __init__(
        self,
        profile_path: Optional[Path] = None,
        user_threshold: float = DEFAULT_USER_THRESHOLD,
        unknown_threshold: float = DEFAULT_UNKNOWN_THRESHOLD,
    ):
        self.profile_path = profile_path or DEFAULT_PROFILE_PATH
        self.user_threshold = user_threshold
        self.unknown_threshold = unknown_threshold

        self._model: Optional[SpeakerModel] = None
        self._enrolled_speaker: Optional[str] = None
        self._enrolled_vector: Optional[np.ndarray] = None
        self._profile_meta: Optional[dict] = None
        self._last_loaded_profile_time: float = 0

    @classmethod
    def get_instance(cls) -> "SpeakerVerificationService":
        """Get or initialize singleton instance."""
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    def ensure_model_loaded(self) -> SpeakerModel:
        """Lazy-loads the Sherpa-ONNX SpeakerModel into RAM."""
        if self._model is None:
            logger.info("[SpeakerService] Initializing Sherpa-ONNX model...")
            start_t = time.perf_counter()
            self._model = SpeakerModel()
            elapsed_ms = (time.perf_counter() - start_t) * 1000
            logger.info(f"[SpeakerService] Model loaded in {elapsed_ms:.1f}ms")
        return self._model

    def ensure_profile_loaded(self, force_reload: bool = False) -> Tuple[str, np.ndarray, dict]:
        """Loads and caches the enrolled speaker profile from disk."""
        if not self.profile_path.exists():
            raise FileNotFoundError(
                f"Speaker profile not found at '{self.profile_path}'. Please run enrollment first."
            )

        mtime = self.profile_path.stat().st_mtime
        if (
            force_reload
            or self._enrolled_vector is None
            or mtime > self._last_loaded_profile_time
        ):
            speaker, vec, meta = load_profile(self.profile_path)
            self._enrolled_speaker = speaker
            self._enrolled_vector = vec
            self._profile_meta = meta
            self._last_loaded_profile_time = mtime
            logger.info(f"[SpeakerService] Loaded profile for '{speaker}' ({len(vec)} dims)")

        model = self.ensure_model_loaded()
        if self._enrolled_vector is not None and len(self._enrolled_vector) != model.dim:
            logger.warning(
                f"[SpeakerService] Profile dimension mismatch ({len(self._enrolled_vector)} vs {model.dim}). "
                "Profile was created with a previous speaker model and must be re-enrolled."
            )
            self.reset_profile()
            raise FileNotFoundError(
                "Enrolled profile was created with a previous speaker model and must be re-enrolled."
            )

        return self._enrolled_speaker, self._enrolled_vector, self._profile_meta

    def classify_score(self, score: float) -> Tuple[str, str]:
        """
        Applies 3-state classification:
          - score >= user_threshold    -> ("USER", "ALLOW")
          - score >= unknown_threshold -> ("UNKNOWN", "WAIT_OR_DISCARD")
          - score < unknown_threshold  -> ("OTHER", "DISCARD")
        """
        if score >= self.user_threshold:
            return self._enrolled_speaker or "USER", "ALLOW"
        elif score >= self.unknown_threshold:
            return "UNKNOWN", "WAIT_OR_DISCARD"
        else:
            return "OTHER", "DISCARD"

    def verify_samples(
        self,
        samples: np.ndarray,
        sample_rate: int = 16000,
    ) -> Dict[str, Any]:
        """
        Verifies a 1D float32 audio numpy array against the enrolled speaker profile.
        Returns detailed decision dict.
        """
        start_t = time.perf_counter()
        speaker_name, enrolled_vec, profile_meta = self.ensure_profile_loaded()
        model = self.ensure_model_loaded()

        duration_sec = len(samples) / float(sample_rate) if sample_rate > 0 else 0.0

        # Energy-based speech trimming: preserve 40ms phonetic headroom before onset and after offset
        eval_samples = samples
        frame_sz = int(0.02 * sample_rate)
        if len(samples) >= frame_sz * 4:
            frame_rms = [float(np.sqrt(np.mean(samples[i : i + frame_sz] ** 2))) for i in range(0, len(samples), frame_sz)]
            max_rms = max(frame_rms) if frame_rms else 0.0
            cutoff = max(0.002, min(0.008, 0.08 * max_rms))
            speech_mask = [r > cutoff for r in frame_rms]
            if any(speech_mask):
                start_frame = max(0, speech_mask.index(True) - 2)
                rev_mask = speech_mask[::-1]
                end_frame = min(len(frame_rms), len(frame_rms) - rev_mask.index(True) + 2)
                trimmed = samples[start_frame * frame_sz : end_frame * frame_sz]
                if len(trimmed) >= int(0.35 * sample_rate):
                    eval_samples = trimmed

        # Ensure minimum temporal frames for CAM++ embedding extractor (>= 0.4s)
        min_samples = int(0.4 * sample_rate)
        if len(eval_samples) < min_samples and len(eval_samples) > 0:
            pad_len = min_samples - len(eval_samples)
            eval_samples = np.pad(eval_samples, (0, pad_len), mode="edge")

        # Extract target embedding
        target_vec = model.extract_embedding_from_samples(eval_samples, sample_rate)

        # Compute cosine similarity
        score = cosine_similarity(enrolled_vec, target_vec)
        verdict_speaker, status = self.classify_score(score)
        inference_ms = (time.perf_counter() - start_t) * 1000

        return {
            "speaker": verdict_speaker,
            "score": round(float(score), 4),
            "verdict": status,
            "is_user": (verdict_speaker == speaker_name),
            "duration_sec": round(duration_sec, 3),
            "latency_ms": round(inference_ms, 2),
            "thresholds": {
                "user": self.user_threshold,
                "unknown": self.unknown_threshold,
            },
            "enrolled_speaker": speaker_name,
            "model_name": model.model_path.name,
        }

    def verify_pcm_bytes(
        self,
        pcm_bytes: bytes,
        sample_rate: int = 16000,
        sample_width: int = 2,
    ) -> Dict[str, Any]:
        """
        Verifies raw linear PCM bytes (default: 16-bit little-endian mono).
        """
        if pcm_bytes.startswith(b"RIFF"):
            import io, wave
            with io.BytesIO(pcm_bytes) as bio:
                with wave.open(bio, "rb") as wf:
                    sr = wf.getframerate()
                    sw = wf.getsampwidth()
                    ch = wf.getnchannels()
                    frames = wf.readframes(wf.getnframes())
                    if sw == 2:
                        samples = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
                    elif sw == 4:
                        samples = np.frombuffer(frames, dtype=np.float32)
                    else:
                        samples = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
                    if ch > 1:
                        samples = samples.reshape(-1, ch).mean(axis=1)
            return self.verify_samples(samples, sample_rate=sr)

        if sample_width == 2:
            samples = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0
        elif sample_width == 4:
            samples = np.frombuffer(pcm_bytes, dtype=np.float32)
        else:
            raise ValueError(f"Unsupported sample width: {sample_width}")

        return self.verify_samples(samples, sample_rate=sample_rate)

    def verify_base64_pcm(
        self,
        base64_data: str,
        sample_rate: int = 16000,
        sample_width: int = 2,
    ) -> Dict[str, Any]:
        """
        Decodes base64-encoded PCM audio and runs verification.
        """
        pcm_bytes = base64.b64decode(base64_data)
        return self.verify_pcm_bytes(pcm_bytes, sample_rate=sample_rate, sample_width=sample_width)

    def get_status(self) -> Dict[str, Any]:
        """Returns the readiness status of the verification service."""
        profile_exists = self.profile_path.exists()
        model_loaded = self._model is not None
        profile_loaded = self._enrolled_vector is not None

        # Verify dimension match if profile exists
        if profile_exists:
            try:
                self.ensure_profile_loaded()
                profile_exists = True
                profile_loaded = True
            except FileNotFoundError:
                profile_exists = False
                profile_loaded = False
        else:
            self.reset_profile()
            profile_loaded = False

        return {
            "ready": profile_exists,
            "model_loaded": model_loaded,
            "profile_loaded": profile_loaded,
            "profile_path": str(self.profile_path),
            "enrolled_speaker": self._enrolled_speaker if profile_loaded else None,
            "thresholds": {
                "user": self.user_threshold,
                "unknown": self.unknown_threshold,
            },
        }

    def get_profile_info(self) -> Dict[str, Any]:
        """Returns details about the currently enrolled voice profile."""
        if not self.profile_path.exists():
            return {"enrolled": False, "message": "No speaker profile found"}

        try:
            speaker, _, meta = self.ensure_profile_loaded()
            return {
                "enrolled": True,
                "speaker": speaker,
                "created_at": meta.get("created_at"),
                "model_name": meta.get("model_name"),
                "dimension": meta.get("dimension"),
                "num_samples": meta.get("num_samples"),
                "avg_alignment": meta.get("avg_alignment"),
                "intra_similarity": meta.get("intra_similarity"),
                "thresholds": {
                    "user": self.user_threshold,
                    "unknown": self.unknown_threshold,
                },
            }
        except FileNotFoundError:
            return {"enrolled": False, "message": "Profile reset due to model upgrade. Please re-enroll."}

    def reset_profile(self) -> bool:
        """Clears cached profile and removes speaker_profile.json if it exists."""
        self._enrolled_speaker = None
        self._enrolled_vector = None
        self._profile_meta = None
        self._last_loaded_profile_time = 0
        if self.profile_path.exists():
            try:
                self.profile_path.unlink()
                logger.info(f"[SpeakerService] Profile deleted: {self.profile_path}")
                return True
            except Exception as e:
                logger.warning(f"[SpeakerService] Could not unlink {self.profile_path}: {e}")
        return False

speaker_verification_service = SpeakerVerificationService()
