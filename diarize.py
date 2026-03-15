#!/usr/bin/env python3
"""
diarize.py — Speaker diarization using pyannote.audio (local inference)

Usage:
    python diarize.py <input.wav>

Output (JSON to stdout):
    [{"start": 0.0, "end": 4.2, "speaker": "SPEAKER_00"}, ...]

Requires HF_TOKEN in environment or .env file.
Accept model terms at: https://hf.co/pyannote/speaker-diarization-3.1
"""

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path


def _load_env():
    """Load .env from the script's directory if python-dotenv isn't available."""
    env_path = Path(__file__).parent / ".env"
    if not env_path.exists():
        return
    with open(env_path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            os.environ.setdefault(key.strip(), val.strip())


def diarize(wav_path: str, hf_token: str | None = None) -> list[dict]:
    """
    Run speaker diarization on a WAV file.

    Args:
        wav_path:  Path to a mono or stereo 16kHz+ WAV file.
        hf_token:  HuggingFace token. Falls back to HF_TOKEN env var.

    Returns:
        List of dicts: [{"start": float, "end": float, "speaker": str}, ...]
        Sorted by start time.
    """
    _load_env()
    token = hf_token or os.environ.get("HF_TOKEN", "")
    if not token:
        raise ValueError(
            "HuggingFace token required. Set HF_TOKEN in .env or pass hf_token=."
        )

    from pyannote.audio import Pipeline  # import here so module loads without torch

    pipeline = Pipeline.from_pretrained(
        "pyannote/speaker-diarization-3.1",
        token=token,
    )

    # torchcodec (pyannote v4's audio backend) requires standard 16kHz mono WAV.
    # Re-encode via ffmpeg into a temp file to guarantee compatibility.
    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    tmp.close()
    subprocess.run(
        ["ffmpeg", "-y", "-i", wav_path,
         "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", tmp.name],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True,
    )

    try:
        output = pipeline(tmp.name)
    finally:
        Path(tmp.name).unlink(missing_ok=True)
    # pyannote v4 wraps result in DiarizeOutput; the annotation lives in .speaker_diarization
    diarization = (
        output.speaker_diarization
        if hasattr(output, "speaker_diarization")
        else output
    )

    segments = []
    for turn, _, speaker in diarization.itertracks(yield_label=True):
        segments.append(
            {
                "start": round(turn.start, 3),
                "end": round(turn.end, 3),
                "speaker": speaker,
            }
        )

    segments.sort(key=lambda s: s["start"])
    return segments


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <input.wav>", file=sys.stderr)
        sys.exit(1)

    wav = sys.argv[1]
    if not Path(wav).exists():
        print(f"Error: file not found: {wav}", file=sys.stderr)
        sys.exit(1)

    print(json.dumps(diarize(wav), indent=2))
