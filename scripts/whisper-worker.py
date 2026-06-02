"""
Long-running Whisper transcription worker.
Reads MP4 file paths from stdin line-by-line, outputs JSON per line to stdout.
Loads model once, transcribes many files.

Usage: echo "/path/to/video.mp4" | python whisper-worker.py [model]
"""
import sys
import json
import subprocess
import tempfile
import os

FFMPEG = "/opt/homebrew/bin/ffmpeg"

# Model from CLI arg or default
model_name = sys.argv[1] if len(sys.argv) > 1 else "mlx-community/whisper-small-mlx"

# Load model once
sys.stderr.write(f"[whisper-worker] Loading model: {model_name}\n")
sys.stderr.flush()

import mlx_whisper

# Warm up with a dummy transcription to trigger model download if needed
sys.stderr.write("[whisper-worker] Ready\n")
sys.stderr.flush()
print(json.dumps({"status": "ready"}), flush=True)

for line in sys.stdin:
    mp4_path = line.strip()
    if not mp4_path:
        continue

    wav_path = None
    try:
        # Extract 16kHz mono audio
        wav_fd, wav_path = tempfile.mkstemp(suffix=".wav")
        os.close(wav_fd)
        subprocess.run(
            [FFMPEG, "-i", mp4_path, "-ar", "16000", "-ac", "1",
             "-f", "wav", "-y", "-loglevel", "error", wav_path],
            capture_output=True, check=True,
        )

        # Transcribe
        result = mlx_whisper.transcribe(
            wav_path,
            path_or_hf_repo=model_name,
            language="en",
        )
        text = (result.get("text") or "").strip()

        print(json.dumps({"path": mp4_path, "text": text}), flush=True)
    except Exception as e:
        print(json.dumps({"path": mp4_path, "error": str(e)}), flush=True)
    finally:
        if wav_path and os.path.exists(wav_path):
            os.unlink(wav_path)
