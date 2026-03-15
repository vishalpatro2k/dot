#!/usr/bin/env bash
# transcribe.sh — Transcribe a WAV file using whisper.cpp (local, offline)
# Usage: ./transcribe.sh <input.wav>
# Output format: [HH:MM:SS] Speaker text here

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODEL="${SCRIPT_DIR}/models/ggml-base.en.bin"
WHISPER_BIN="$(command -v whisper-cli 2>/dev/null || true)"

# ── validation ────────────────────────────────────────────────────────────────
if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <input.wav>"
  exit 1
fi

INPUT="$1"

if [[ ! -f "$INPUT" ]]; then
  echo "Error: file not found: $INPUT"
  exit 1
fi

if [[ -z "$WHISPER_BIN" ]]; then
  echo "Error: whisper-cli not found. Install with: brew install whisper-cpp"
  exit 1
fi

if [[ ! -f "$MODEL" ]]; then
  echo "Error: model not found at $MODEL"
  echo "Download with:"
  echo "  mkdir -p \"${SCRIPT_DIR}/models\""
  echo "  curl -L https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin \\"
  echo "       -o \"${MODEL}\""
  exit 1
fi

# ── transcribe ────────────────────────────────────────────────────────────────
# whisper-cli outputs lines like:
#   [00:00:00.000 --> 00:00:05.000]   Some text here.
# We reformat to:
#   [00:00:00] Some text here.

"$WHISPER_BIN" \
  -m "$MODEL" \
  -l en \
  --no-prints \
  "$INPUT" 2>/dev/null \
| sed -E 's/\[([0-9]{2}:[0-9]{2}:[0-9]{2})\.[0-9]+ --> [^]]+\][[:space:]]*/[\1] /'
