#!/usr/bin/env bash
# record_audio.sh — Record system audio via BlackHole 2ch
# Usage: ./record_audio.sh <output_filename.wav> <duration_seconds>

set -euo pipefail

# ── helpers ──────────────────────────────────────────────────────────────────
usage() {
  echo "Usage: $0 <output_file.wav> <duration_seconds>"
  echo "  e.g. $0 meeting.wav 300"
  exit 1
}

# ── list devices (always shown) ───────────────────────────────────────────────
echo "Available audio devices:"
ffmpeg -f avfoundation -list_devices true -i "" 2>&1 \
  | grep -E '^\[AVFoundation' \
  | grep -v 'AVFoundation input device' \
  || true
echo ""

# ── arg validation ────────────────────────────────────────────────────────────
[[ $# -lt 2 ]] && usage

OUTPUT="$1"
DURATION="$2"

# Ensure output ends in .wav
if [[ "$OUTPUT" != *.wav ]]; then
  OUTPUT="${OUTPUT}.wav"
fi

# ── find BlackHole device index ───────────────────────────────────────────────
# ffmpeg audio device lines look like: "[AVFoundation ...] [2] BlackHole 2ch"
DEVICE_INDEX=$(
  ffmpeg -f avfoundation -list_devices true -i "" 2>&1 \
    | grep -i 'BlackHole 2ch' \
    | grep -oE '\[[0-9]+\] BlackHole' \
    | grep -oE '[0-9]+' \
    | head -1
) || true

if [[ -z "$DEVICE_INDEX" ]]; then
  echo "Error: BlackHole 2ch not found. Make sure it is installed and you have rebooted."
  echo "Install with: brew install --cask blackhole-2ch"
  exit 1
fi

echo "Recording from BlackHole 2ch (device index: $DEVICE_INDEX)"
echo "  Output : $OUTPUT"
echo "  Duration: ${DURATION}s"
echo ""
echo "Press Ctrl-C to stop early."

ffmpeg -y \
  -f avfoundation \
  -i "none:${DEVICE_INDEX}" \
  -t "$DURATION" \
  -ar 44100 \
  -ac 2 \
  -c:a pcm_s16le \
  "$OUTPUT"

echo ""
echo "Saved: $OUTPUT"
