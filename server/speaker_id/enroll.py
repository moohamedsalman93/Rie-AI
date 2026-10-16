"""
Speaker Enrollment Script.
Extracts speaker embeddings from one or more audio samples of the user,
averages and normalizes them, and saves the enrolled profile to data/speaker_profile.json.
"""

import sys
import json
import wave
import logging
import argparse
from datetime import datetime
from pathlib import Path
from typing import List, Optional, Tuple
import numpy as np

from .model import SpeakerModel, cosine_similarity, load_wav_file, DATA_DIR, SAMPLES_DIR

logger = logging.getLogger("speaker_enroll")

DEFAULT_PROFILE_PATH = DATA_DIR / "speaker_profile.json"


def trim_speech(samples: np.ndarray, sample_rate: int = 16000) -> np.ndarray:
    """
    Isolates active speech and removes leading/trailing silence from an audio clip.
    Ensures that speaker embeddings are computed purely from vocal tract acoustics,
    without contamination from stationary room or microphone noise floors.
    """
    frame_sz = int(0.02 * sample_rate)
    if len(samples) < frame_sz * 4:
        return samples
    frame_rms = [float(np.sqrt(np.mean(samples[i : i + frame_sz] ** 2))) for i in range(0, len(samples), frame_sz)]
    max_rms = max(frame_rms) if frame_rms else 0.0
    if max_rms < 0.002:
        return samples
    cutoff = max(0.003, min(0.012, 0.12 * max_rms))
    speech_mask = [r > cutoff for r in frame_rms]
    if any(speech_mask):
        start_frame = max(0, speech_mask.index(True) - 1)
        rev_mask = speech_mask[::-1]
        end_frame = min(len(frame_rms), len(frame_rms) - rev_mask.index(True) + 1)
        trimmed = samples[start_frame * frame_sz : end_frame * frame_sz]
        if len(trimmed) >= int(0.4 * sample_rate):
            return trimmed
    return samples


def enroll_speaker_from_arrays(
    audio_data_list: List[Tuple[np.ndarray, int]],
    profile_path: Optional[Path] = None,
    speaker_name: str = "USER",
    model: Optional[SpeakerModel] = None,
    save_to_samples_dir: bool = True,
) -> dict:
    """
    Takes a list of (float32_samples, sample_rate) tuples, generates an average
    normalized embedding, computes intra-sample consistency scores, and saves to JSON.
    Optionally saves the raw audio samples to speaker_id/samples/user_XX.wav.
    """
    if not audio_data_list:
        raise ValueError("At least one audio sample is required for enrollment.")

    target_profile = profile_path or DEFAULT_PROFILE_PATH
    target_profile.parent.mkdir(parents=True, exist_ok=True)

    spk_model = model or SpeakerModel()
    embeddings = []
    durations = []
    valid_paths = []

    if save_to_samples_dir:
        SAMPLES_DIR.mkdir(parents=True, exist_ok=True)

    for idx, (raw_samples, sr) in enumerate(audio_data_list):
        if len(raw_samples) == 0:
            continue
        samples = trim_speech(raw_samples, sr)
        duration = len(samples) / float(sr)
        emb = spk_model.extract_embedding_from_samples(samples, sr)
        embeddings.append(emb)
        durations.append(duration)

        path_str = f"memory_sample_{idx+1:02d}"
        if save_to_samples_dir:
            sample_file = SAMPLES_DIR / f"user_{idx+1:02d}.wav"
            try:
                int_samples = (np.clip(samples, -1.0, 1.0) * 32767.0).astype(np.int16)
                with wave.open(str(sample_file), "wb") as wf:
                    wf.setnchannels(1)
                    wf.setsampwidth(2)
                    wf.setframerate(sr)
                    wf.writeframes(int_samples.tobytes())
                path_str = str(sample_file)
            except Exception as e:
                logger.warning(f"Could not save WAV to {sample_file}: {e}")
        valid_paths.append(path_str)

    if not embeddings:
        raise RuntimeError("No valid audio samples could be processed.")

    # 1. Compute averaged embedding
    avg_vec = np.mean(embeddings, axis=0)
    norm = np.linalg.norm(avg_vec)
    if norm > 0:
        avg_vec = avg_vec / norm
    else:
        raise RuntimeError("Computed zero-norm average vector.")

    # 2. Check intra-speaker consistency (similarity of each sample to the average)
    consistencies = [cosine_similarity(e, avg_vec) for e in embeddings]
    avg_consistency = float(np.mean(consistencies))

    # 3. Save profile
    profile_data = {
        "speaker": speaker_name,
        "created_at": datetime.now().isoformat(),
        "model_name": spk_model.model_path.name,
        "dimension": spk_model.dim,
        "num_samples": len(embeddings),
        "source_samples": valid_paths,
        "intra_similarity": [round(float(s), 4) for s in consistencies],
        "avg_alignment": round(avg_consistency, 4),
        "embedding": [float(x) for x in avg_vec],
    }

    with open(target_profile, "w", encoding="utf-8") as f:
        json.dump(profile_data, f, indent=2)

    return profile_data


def enroll_speaker(
    sample_paths: List[Path],
    profile_path: Optional[Path] = None,
    speaker_name: str = "USER",
    model: Optional[SpeakerModel] = None,
) -> dict:
    """
    Takes a list of audio sample paths, generates an average normalized embedding,
    computes intra-sample consistency scores, and saves to JSON.
    """
    if not sample_paths:
        raise ValueError("At least one audio sample is required for enrollment.")

    target_profile = profile_path or DEFAULT_PROFILE_PATH
    target_profile.parent.mkdir(parents=True, exist_ok=True)

    spk_model = model or SpeakerModel()
    embeddings = []
    durations = []
    valid_paths = []

    print(f"\n==========================================")
    print(f" Speaker Enrollment: '{speaker_name}'")
    print(f"==========================================")
    print(f"Embedding dimension: {spk_model.dim}")
    print(f"Processing {len(sample_paths)} sample(s)...\n")

    for p in sample_paths:
        path = Path(p)
        if not path.exists():
            print(f"[-] Warning: File not found: {path}, skipping.")
            continue

        try:
            sr, raw_samples = load_wav_file(path)
            samples = trim_speech(raw_samples, sr)
            duration = len(samples) / float(sr)
            emb = spk_model.extract_embedding_from_samples(samples, sr)
            embeddings.append(emb)
            durations.append(duration)
            valid_paths.append(str(path))
            print(f"[+] Loaded: {path.name:<25} ({duration:5.2f}s) -> Embedding computed")
        except Exception as e:
            print(f"[-] Error loading {path.name}: {e}")

    if not embeddings:
        raise RuntimeError("No valid audio samples could be processed.")

    # 1. Compute averaged embedding
    avg_vec = np.mean(embeddings, axis=0)
    norm = np.linalg.norm(avg_vec)
    if norm > 0:
        avg_vec = avg_vec / norm
    else:
        raise RuntimeError("Computed zero-norm average vector.")

    # 2. Check intra-speaker consistency (similarity of each sample to the average)
    consistencies = [cosine_similarity(e, avg_vec) for e in embeddings]
    avg_consistency = float(np.mean(consistencies))

    print("\n------------------------------------------")
    print("Intra-Sample Consistency Scores:")
    for path_str, score in zip(valid_paths, consistencies):
        print(f"  * {Path(path_str).name:<25} : {score:.4f}")
    print(f"Average Profile Alignment : {avg_consistency:.4f}")

    if avg_consistency >= 0.80:
        print("[+] Quality Assessment: EXCELLENT (Consistent voice timbre)")
    elif avg_consistency >= 0.65:
        print("[!] Quality Assessment: GOOD (Minor background noise or acoustic variance)")
    else:
        print("[?] Quality Assessment: LOW (Check microphone placement, room echo, or tone consistency)")

    # 3. Save profile
    profile_data = {
        "speaker": speaker_name,
        "created_at": datetime.now().isoformat(),
        "model_name": spk_model.model_path.name,
        "dimension": spk_model.dim,
        "num_samples": len(embeddings),
        "source_samples": valid_paths,
        "intra_similarity": [round(float(s), 4) for s in consistencies],
        "avg_alignment": round(avg_consistency, 4),
        "embedding": [float(x) for x in avg_vec],
    }

    with open(target_profile, "w", encoding="utf-8") as f:
        json.dump(profile_data, f, indent=2)

    print(f"\n[+] Successfully saved speaker profile to:\n    {target_profile}")
    print(f"==========================================\n")
    return profile_data


def main():
    parser = argparse.ArgumentParser(description="Enroll a user voice profile using one or more audio samples.")
    parser.add_argument(
        "samples",
        nargs="*",
        help="Path(s) to audio WAV samples (e.g. samples/user_01.wav samples/user_02.wav). "
             "If omitted, automatically scans 'samples/user_*.wav'.",
    )
    parser.add_argument(
        "--output",
        "-o",
        type=Path,
        default=DEFAULT_PROFILE_PATH,
        help="Path to save speaker_profile.json (default: data/speaker_profile.json)",
    )
    parser.add_argument(
        "--name",
        "-n",
        default="USER",
        help="Name of the speaker (default: USER)",
    )

    args = parser.parse_args()

    sample_files = [Path(s) for s in args.samples] if args.samples else []
    if not sample_files:
        # Auto-discover user_*.wav in SAMPLES_DIR
        sample_files = sorted(list(SAMPLES_DIR.glob("user_*.wav")))
        if not sample_files:
            # Check relative to cwd
            sample_files = sorted(list(Path("samples").glob("user_*.wav")))

    if not sample_files:
        print("[-] Error: No audio samples provided or found in 'samples/user_*.wav'.")
        print("\nPlease record or place 1-3 WAV samples (16kHz mono) in 'samples/':")
        print("  samples/user_01.wav")
        print("  samples/user_02.wav")
        print("  samples/user_03.wav")
        print("\nOr specify files directly:")
        print("  python -m speaker_id.enroll path/to/sample1.wav path/to/sample2.wav")
        sys.exit(1)

    enroll_speaker(sample_files, profile_path=args.output, speaker_name=args.name)


if __name__ == "__main__":
    main()
