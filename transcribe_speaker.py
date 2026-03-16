#!/usr/bin/env python3
"""
transcribe_speaker.py — Whisper transcription + pyannote speaker diarization

Usage:
    python transcribe_speaker.py <input.wav> [--hf-token TOKEN]

Output:
    [00:00:00] Speaker 1: And so my fellow Americans...
    [00:00:08] Speaker 2: Ask not what your country...

Requires:
    - whisper-cli on PATH  (brew install whisper-cpp)
    - models/ggml-base.en.bin in the script's directory
    - HF_TOKEN in .env (free token at https://huggingface.co/settings/tokens)
    - Accept pyannote terms at https://hf.co/pyannote/speaker-diarization-3.1
"""

import argparse
import os
import re
import subprocess
import sys
from pathlib import Path


# ── env loader ────────────────────────────────────────────────────────────────

def _load_env():
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


# ── whisper ───────────────────────────────────────────────────────────────────

def run_whisper(wav_path: str) -> list[dict]:
    """
    Call whisper-cli and parse output into segments.

    Returns:
        [{"start_sec": float, "end_sec": float, "text": str}, ...]
    """
    script_dir = Path(__file__).parent
    model = script_dir / "models" / "ggml-base.en.bin"

    whisper_bin = subprocess.run(
        ["which", "whisper-cli"], capture_output=True, text=True
    ).stdout.strip()
    if not whisper_bin:
        sys.exit("Error: whisper-cli not found. Install with: brew install whisper-cpp")
    if not model.exists():
        sys.exit(f"Error: model not found at {model}")

    result = subprocess.run(
        [whisper_bin, "-m", str(model), "-l", "en", "--no-prints", wav_path],
        capture_output=True,
        text=True,
    )
    # whisper-cli writes transcript to stdout, progress to stderr
    raw = result.stdout

    # Format: [00:00:00.000 --> 00:00:05.000]   text here
    pattern = re.compile(
        r"\[(\d{2}):(\d{2}):(\d{2})\.(\d+)\s*-->\s*(\d{2}):(\d{2}):(\d{2})\.(\d+)\]\s*(.*)"
    )
    segments = []
    for line in raw.splitlines():
        m = pattern.match(line.strip())
        if not m:
            continue
        h0, m0, s0, _ms0, h1, m1, s1, _ms1 = m.groups()[:8]
        text = m.group(9).strip()
        if not text:
            continue
        start = int(h0) * 3600 + int(m0) * 60 + int(s0)
        end   = int(h1) * 3600 + int(m1) * 60 + int(s1)
        segments.append({"start_sec": start, "end_sec": end, "text": text})

    return segments


# ── merge ─────────────────────────────────────────────────────────────────────

def _overlap(a_start, a_end, b_start, b_end) -> float:
    return max(0.0, min(a_end, b_end) - max(a_start, b_start))


def assign_speakers(
    whisper_segments: list[dict],
    diarization_segments: list[dict],
) -> list[dict]:
    """
    For each Whisper segment, pick the speaker with the most overlap.
    Falls back to nearest speaker if no overlap found.

    Returns:
        [{"start_sec": int, "speaker": str, "text": str}, ...]
    """
    # Build friendly labels: SPEAKER_00 → "Speaker 1", etc.
    seen: dict[str, str] = {}
    counter = 1

    def friendly(raw: str) -> str:
        nonlocal counter
        if raw not in seen:
            seen[raw] = f"Speaker {counter}"
            counter += 1
        return seen[raw]

    result = []
    for ws in whisper_segments:
        ws_start, ws_end = ws["start_sec"], ws["end_sec"]
        if ws_end <= ws_start:
            ws_end = ws_start + 1  # guard zero-length segments

        best_speaker = None
        best_overlap = 0.0

        for ds in diarization_segments:
            ov = _overlap(ws_start, ws_end, ds["start"], ds["end"])
            if ov > best_overlap:
                best_overlap = ov
                best_speaker = ds["speaker"]

        # fallback: nearest segment by midpoint distance
        if best_speaker is None and diarization_segments:
            mid = (ws_start + ws_end) / 2
            best_speaker = min(
                diarization_segments,
                key=lambda d: abs((d["start"] + d["end"]) / 2 - mid),
            )["speaker"]

        result.append(
            {
                "start_sec": ws_start,
                "speaker": friendly(best_speaker) if best_speaker else "Speaker ?",
                "text": ws["text"],
            }
        )

    return result


# ── format ────────────────────────────────────────────────────────────────────

def format_transcript(segments: list[dict]) -> str:
    lines = []
    for seg in segments:
        t = seg["start_sec"]
        hh = t // 3600
        mm = (t % 3600) // 60
        ss = t % 60
        lines.append(f"[{hh:02d}:{mm:02d}:{ss:02d}] {seg['speaker']}: {seg['text']}")
    return "\n".join(lines)


# ── main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Transcribe + diarize a WAV file")
    parser.add_argument("wav", help="Path to input WAV file")
    parser.add_argument("--hf-token", help="HuggingFace token (overrides HF_TOKEN in .env)")
    parser.add_argument("--identify", action="store_true",
                        help="Map 'Speaker N' labels to real names via Claude + Notion calendar")
    parser.add_argument("--attendees",
                        help="Comma-separated attendee list for --identify (overrides Notion lookup)")
    parser.add_argument("--summarize", action="store_true",
                        help="Extract summary, decisions, and action items via Claude Sonnet")
    parser.add_argument("--title", default="Meeting Notes",
                        help="Meeting title for --summarize (default: 'Meeting Notes')")
    parser.add_argument("--no-save", action="store_true",
                        help="With --summarize: print only, skip saving to Notion")
    args = parser.parse_args()

    if not Path(args.wav).exists():
        sys.exit(f"Error: file not found: {args.wav}")

    # Guard against empty/too-short recordings before spending time on whisper.
    # 44100 Hz * 2 ch * 2 bytes = ~176 KB/s; require at least ~1 second of audio.
    wav_bytes = Path(args.wav).stat().st_size
    if wav_bytes < 180_000:
        sys.exit(
            "Error: Recording too short or silent. "
            "Make sure BlackHole 2ch is set as your Output device (System Settings → Sound) "
            "so meeting audio routes through it before you start recording."
        )

    _load_env()
    hf_token = args.hf_token or os.environ.get("HF_TOKEN", "")
    if not hf_token:
        sys.exit(
            "Error: HuggingFace token required.\n"
            "  1. Get a free token at https://huggingface.co/settings/tokens\n"
            "  2. Accept model terms at https://hf.co/pyannote/speaker-diarization-3.1\n"
            "  3. Add HF_TOKEN=<token> to .env  (or pass --hf-token)"
        )

    print("Running Whisper transcription...", file=sys.stderr)
    whisper_segs = run_whisper(args.wav)
    if not whisper_segs:
        sys.exit("Whisper returned no segments — is the audio file silent?")

    print("Running speaker diarization...", file=sys.stderr)
    from diarize import diarize
    diar_segs = diarize(args.wav, hf_token=hf_token)

    merged = assign_speakers(whisper_segs, diar_segs)
    transcript = format_transcript(merged)

    if args.identify:
        from identify_speakers import identify_speakers
        explicit = (
            [a.strip() for a in args.attendees.split(",") if a.strip()]
            if args.attendees else None
        )
        print("Identifying speakers with Claude...", file=sys.stderr)
        transcript = identify_speakers(transcript, attendees=explicit)

    if args.summarize:
        from summarize_meeting import extract_attendees_from_transcript, extract_meeting_data, format_summary, save_to_notion
        from datetime import date as _date
        attendees = (
            [a.strip() for a in args.attendees.split(",") if a.strip()]
            if args.attendees
            else extract_attendees_from_transcript(transcript)
        )
        print("Summarizing meeting with Claude Sonnet...", file=sys.stderr)
        data = extract_meeting_data(transcript, args.title)
        today = _date.today().isoformat()
        print(format_summary(data, args.title, today, attendees))
        if not args.no_save:
            save_to_notion(data, args.title, attendees, today)
    else:
        print(transcript)


if __name__ == "__main__":
    main()
