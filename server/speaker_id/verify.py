"""
Speaker Verification Script.
Compares a target audio sample against the enrolled speaker profile
and outputs the similarity score and USER / OTHER classification.
"""

import sys
import json
import argparse
from pathlib import Path
from typing import Optional, Union, Tuple
import numpy as np

from .model import SpeakerModel, cosine_similarity, load_wav_file, DATA_DIR

DEFAULT_PROFILE_PATH = DATA_DIR / "speaker_profile.json"


def load_profile(profile_path: Optional[Path] = None) -> Tuple[str, np.ndarray, dict]:
    """Loads enrolled speaker profile JSON and returns (speaker_name, embedding_vector, full_dict)."""
    p = profile_path or DEFAULT_PROFILE_PATH
    if not p.exists():
        raise FileNotFoundError(
            f"Speaker profile not found at '{p}'.\n"
            "Please run enrollment first:\n"
            "  python -m speaker_id.enroll samples/user_01.wav samples/user_02.wav"
        )

    with open(p, "r", encoding="utf-8") as f:
        data = json.load(f)

    speaker = data.get("speaker", "USER")
    embedding = np.array(data["embedding"], dtype=np.float32)
    norm = np.linalg.norm(embedding)
    if norm > 0:
        embedding = embedding / norm

    return speaker, embedding, data


def verify_audio(
    audio_path: Union[str, Path],
    profile_path: Optional[Path] = None,
    threshold: float = 0.70,
    model: Optional[SpeakerModel] = None,
) -> Tuple[str, float, dict]:
    """
    Verifies if the audio file matches the enrolled profile.
    Returns: (verdict: "USER" | "OTHER", score: float, details: dict)
    """
    path = Path(audio_path)
    if not path.exists():
        raise FileNotFoundError(f"Audio file not found: {path}")

    speaker_name, enrolled_vec, profile_meta = load_profile(profile_path)
    spk_model = model or SpeakerModel()

    sr, samples = load_wav_file(path)
    duration_sec = len(samples) / float(sr)
    target_vec = spk_model.extract_embedding_from_samples(samples, sr)

    score = cosine_similarity(enrolled_vec, target_vec)
    # Cosine similarity is in [-1.0, 1.0]. High similarity typically > 0.65-0.85
    verdict = speaker_name if score >= threshold else "OTHER"

    details = {
        "file": str(path),
        "duration_sec": round(duration_sec, 2),
        "score": round(score, 4),
        "verdict": verdict,
        "threshold": threshold,
        "enrolled_speaker": speaker_name,
        "model": spk_model.model_path.name,
    }
    return verdict, score, details


def main():
    parser = argparse.ArgumentParser(description="Verify if a speech sample matches the enrolled user profile.")
    parser.add_argument("audio_file", help="Path to the WAV file to verify (e.g. samples/user_02.wav)")
    parser.add_argument(
        "--profile",
        "-p",
        type=Path,
        default=DEFAULT_PROFILE_PATH,
        help="Path to speaker_profile.json (default: data/speaker_profile.json)",
    )
    parser.add_argument(
        "--threshold",
        "-t",
        type=float,
        default=0.70,
        help="Decision threshold for USER vs OTHER (default: 0.70). Used for indication only.",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Output raw JSON format instead of human-readable text.",
    )

    args = parser.parse_args()

    try:
        verdict, score, details = verify_audio(
            args.audio_file,
            profile_path=args.profile,
            threshold=args.threshold,
        )

        if args.json:
            print(json.dumps(details, indent=2))
        else:
            print(f"\nSpeaker: {verdict}")
            print(f"Score:   {score:.4f}")
            print(f"File:    {Path(args.audio_file).name} ({details['duration_sec']}s)")
            print(f"Status:  {'MATCH (' + verdict + ')' if verdict == details['enrolled_speaker'] else 'DIFFERENT SPEAKER (OTHER)'}")
            print(f"(Current reference threshold: {args.threshold})\n")

    except Exception as e:
        print(f"\n[-] Error: {e}\n", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
