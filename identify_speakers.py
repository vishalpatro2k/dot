#!/usr/bin/env python3
"""
identify_speakers.py — Map "Speaker N" labels to real names using Claude.

Uses the same routing logic as src/llm/router.ts:
  "analyze" task → claude-sonnet-4-6 (complex reasoning needed for name mapping)

Two sources of context are combined:
  1. Notion calendar attendees for the meeting date (fetched automatically)
  2. Context clues in the transcript itself (name mentions, role references)

Usage:
    python identify_speakers.py <transcript_file_or_-> [--attendees "Alice, Bob"] [--date YYYY-MM-DD]

    # Pipe from transcribe_speaker.py:
    python transcribe_speaker.py meeting.wav | python identify_speakers.py -

    # With explicit attendees:
    python identify_speakers.py transcript.txt --attendees "Sarah Chen, Mike Torres, Priya Nair"

Output:
    [00:00:15] Sarah: text here
    [00:00:32] Mike: response here
"""

import argparse
import os
import re
import sys
from datetime import date
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


# ── Notion attendee fetching ──────────────────────────────────────────────────

def fetch_notion_attendees(target_date: str | None = None) -> list[str]:
    """
    Fetch meeting attendees from today's Notion calendar entries.
    Returns a list of names found in meeting titles / attendee fields.
    Falls back to empty list if Notion is unavailable.
    """
    token = os.environ.get("NOTION_TOKEN", "")
    if not token:
        return []

    try:
        from notion_client import Client

        notion = Client(auth=token)
        date_str = target_date or date.today().isoformat()

        # Discover databases (mirrors NotionCalendarTool.init logic)
        search_resp = notion.search(page_size=50)
        db_ids: set[str] = set()
        for result in search_resp.get("results", []):
            parent = result.get("parent", {})
            if parent.get("type") == "database_id":
                db_ids.add(parent["database_id"])

        attendees: list[str] = []

        for db_id in db_ids:
            try:
                resp = notion.databases.query(
                    database_id=db_id,
                    page_size=20,
                    filter={"property": "Date", "date": {"equals": date_str}},
                )
            except Exception:
                continue

            for page in resp.get("results", []):
                props = page.get("properties", {})
                for key, prop in props.items():
                    k = key.lower()
                    # Title often contains the meeting name with attendee names
                    if prop.get("type") == "title":
                        text = "".join(t.get("plain_text", "") for t in prop.get("title", []))
                        if text:
                            # Extract capitalized words that look like names
                            names = _extract_names_from_text(text)
                            attendees.extend(names)
                    # Common attendee field names
                    elif k in ("attendees", "participants", "people", "guests"):
                        if prop.get("type") == "rich_text":
                            text = "".join(
                                t.get("plain_text", "") for t in prop.get("rich_text", [])
                            )
                            if text:
                                # Assume comma/semicolon separated names
                                parts = re.split(r"[,;]", text)
                                attendees.extend(p.strip() for p in parts if p.strip())
                        elif prop.get("type") == "multi_select":
                            attendees.extend(
                                opt.get("name", "") for opt in prop.get("multi_select", [])
                            )
                        elif prop.get("type") == "people":
                            for person in prop.get("people", []):
                                name = person.get("name", "")
                                if name:
                                    attendees.append(name)

        # Deduplicate while preserving order
        seen: set[str] = set()
        unique: list[str] = []
        for name in attendees:
            if name and name not in seen:
                seen.add(name)
                unique.append(name)

        return unique

    except Exception as e:
        print(f"[identify_speakers] Notion fetch failed: {e}", file=sys.stderr)
        return []


def _extract_names_from_text(text: str) -> list[str]:
    """Heuristic: extract capitalized word pairs that look like First Last names."""
    # Match "Firstname Lastname" patterns (capital first letters, no digits)
    pattern = re.compile(r"\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b")
    return pattern.findall(text)


# ── Claude name mapping ───────────────────────────────────────────────────────

def identify_speakers(
    transcript: str,
    attendees: list[str] | None = None,
    target_date: str | None = None,
) -> str:
    """
    Use Claude (Sonnet — "analyze" task per router logic) to map generic
    speaker labels to real names, then return the relabeled transcript.

    Args:
        transcript:   Multi-line string with lines like "[HH:MM:SS] Speaker N: text"
        attendees:    Optional explicit attendee list (overrides Notion lookup)
        target_date:  ISO date string for Notion lookup (defaults to today)

    Returns:
        Transcript string with real names substituted where confident.
    """
    import anthropic

    _load_env()

    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        sys.exit("Error: ANTHROPIC_API_KEY not set in .env")

    client = anthropic.Anthropic(api_key=api_key)

    # Gather attendees: explicit list overrides Notion
    if attendees is None:
        print("[identify_speakers] Fetching attendees from Notion...", file=sys.stderr)
        attendees = fetch_notion_attendees(target_date)

    attendee_block = (
        "Meeting attendees from calendar:\n" + "\n".join(f"  - {a}" for a in attendees)
        if attendees
        else "No attendee list available — rely on context clues in the transcript."
    )

    prompt = f"""You are analyzing a meeting transcript where speakers have been labeled generically
(Speaker 1, Speaker 2, etc.) by an automated diarization system.

Your task: replace each generic label with the speaker's real first name, based on:
1. The attendee list below
2. Any name mentions, self-introductions, or role references in the transcript itself

{attendee_block}

Rules:
- Use ONLY first names in the output (e.g., "Sarah", not "Sarah Chen")
- If you are confident about a speaker's identity, replace their label
- If you cannot confidently identify a speaker, keep the label as-is (e.g., "Speaker 2")
- Do NOT add explanations — return ONLY the relabeled transcript, nothing else
- Preserve the exact timestamp format: [HH:MM:SS]
- Preserve the exact text after the colon — do not paraphrase or modify it

TRANSCRIPT:
{transcript}

Return the full transcript with speaker labels replaced by real names where known."""

    # "analyze" task → Sonnet (matching router.ts selectModel logic)
    response = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=4096,
        thinking={"type": "adaptive"},
        messages=[{"role": "user", "content": prompt}],
    )

    return next(
        (block.text for block in response.content if block.type == "text"),
        transcript,  # fallback: return original if no text block
    )


# ── main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Map 'Speaker N' labels to real names using Claude"
    )
    parser.add_argument(
        "input",
        help="Transcript file path, or '-' to read from stdin",
    )
    parser.add_argument(
        "--attendees",
        help="Comma-separated list of meeting attendees (overrides Notion lookup)",
    )
    parser.add_argument(
        "--date",
        help="Meeting date as YYYY-MM-DD for Notion lookup (defaults to today)",
    )
    args = parser.parse_args()

    # Read transcript
    if args.input == "-":
        transcript = sys.stdin.read().strip()
    else:
        path = Path(args.input)
        if not path.exists():
            sys.exit(f"Error: file not found: {args.input}")
        transcript = path.read_text().strip()

    if not transcript:
        sys.exit("Error: transcript is empty")

    # Parse explicit attendees
    explicit_attendees: list[str] | None = None
    if args.attendees:
        explicit_attendees = [a.strip() for a in args.attendees.split(",") if a.strip()]

    print("[identify_speakers] Mapping speaker labels with Claude...", file=sys.stderr)
    result = identify_speakers(transcript, attendees=explicit_attendees, target_date=args.date)
    print(result)


if __name__ == "__main__":
    main()
