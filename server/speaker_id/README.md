# Speaker Identification Benchmark (Sherpa-ONNX)

Standalone offline speaker verification sandbox for Rie-AI.

## Architecture

```text
audio.wav (16kHz mono PCM)
       ↓
Sherpa-ONNX (wespeaker_en_voxceleb_CAM++.onnx)
       ↓
512-dim L2-normalized embedding
       ↓
Cosine similarity against enrolled USER profile
       ↓
┌─────────┬─────────┐
│  USER   │  OTHER  │
└─────────┴─────────┘
```

## Quick Commands

Run all commands from `app/server`:

### 1. Record Microphone Samples
Record genuine audio samples directly from your PC microphone (16kHz mono PCM WAV):
```bash
# Record 5 user samples (different sentences & natural conditions)
poetry run python -m speaker_id.record_samples user_01
poetry run python -m speaker_id.record_samples user_02
poetry run python -m speaker_id.record_samples user_03
poetry run python -m speaker_id.record_samples user_04
poetry run python -m speaker_id.record_samples user_05

# Record another person's voice (negative test samples)
poetry run python -m speaker_id.record_samples other_01
poetry run python -m speaker_id.record_samples other_02
poetry run python -m speaker_id.record_samples other_03
```

### 2. Enroll User Voice
Once you have recorded your voice samples, generate the enrolled profile:
```bash
poetry run python -m speaker_id.enroll
```
Or specify explicit files:
```bash
poetry run python -m speaker_id.enroll path/to/sample1.wav path/to/sample2.wav
```
This generates and saves the average embedding vector to `speaker_id/data/speaker_profile.json`.

### 3. Verify an Audio Sample
```bash
poetry run python -m speaker_id.verify speaker_id/samples/user_02.wav
```
Output:
```text
Speaker: USER
Score:   0.8730
File:    user_02.wav (5.04s)
Status:  MATCH (USER)
```

And for another person's voice:
```bash
poetry run python -m speaker_id.verify speaker_id/samples/other_01.wav
```
Output:
```text
Speaker: OTHER
Score:   0.4695
File:    other_01.wav (4.66s)
Status:  DIFFERENT SPEAKER (OTHER)
```

### 4. Run Benchmark Suite
Place multiple `user_*.wav` and `other_*.wav` files in `speaker_id/samples/` and run:
```bash
poetry run python -m speaker_id.benchmark
```
This produces the evaluation table, separation margin, and recommended threshold for your specific microphone and room environment.

### 5. Regenerate Synthetic Validation Audio
To re-test using Windows native TTS voices (David as USER, Zira as OTHER):
```bash
poetry run python -m speaker_id.generate_test_samples
```
