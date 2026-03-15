#!/usr/bin/env python3
"""
summarize_meeting.py — Extract structured meeting notes from a named transcript,
then optionally save to a Notion database.

Usage:
    python summarize_meeting.py <transcript_file_or_-> [options]

    # Print summary only
    python summarize_meeting.py transcript.txt --title "Design Review"

    # Full pipeline: record → transcribe → diarize → identify → summarize → Notion
    python transcribe_speaker.py meeting.wav --identify | \\
        python summarize_meeting.py - --title "Design Review" --database "Meeting Notes"

Options:
    --title       Meeting title (used as Notion page title)
    --attendees   Comma-separated names (inferred from transcript if omitted)
    --date        YYYY-MM-DD (defaults to today)
    --database    Notion database name to save into (case-insensitive prefix match)
    --no-save     Extract and print only, skip Notion even if database is found
"""

import argparse
import json
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


# ── attendee extraction ───────────────────────────────────────────────────────

def extract_attendees_from_transcript(transcript: str) -> list[str]:
    """Pull unique speaker names from '[HH:MM:SS] Name: text' lines."""
    names: list[str] = []
    seen: set[str] = set()
    for line in transcript.splitlines():
        m = re.match(r"\[\d{2}:\d{2}:\d{2}\]\s+(.+?):", line)
        if m:
            name = m.group(1).strip()
            if name not in seen and not re.match(r"^Speaker\s+\d+$", name):
                seen.add(name)
                names.append(name)
    return names


# ── Claude extraction ─────────────────────────────────────────────────────────

EXTRACTION_SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {
            "type": "array",
            "items": {"type": "string"},
            "description": "3-5 concise bullet points summarising the meeting"
        },
        "decisions": {
            "type": "array",
            "items": {"type": "string"},
            "description": "Concrete decisions that were made (empty list if none)"
        },
        "action_items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "task":  {"type": "string"},
                    "owner": {"type": ["string", "null"]}
                },
                "required": ["task", "owner"],
                "additionalProperties": False
            },
            "description": "Action items with optional owner name"
        },
        "key_topics": {
            "type": "array",
            "items": {"type": "string"},
            "description": "Main topics discussed (3-6 short phrases)"
        }
    },
    "required": ["summary", "decisions", "action_items", "key_topics"],
    "additionalProperties": False
}


def extract_meeting_data(transcript: str, title: str) -> dict:
    """
    Use Claude Sonnet (router: 'summarize'/'analyze' → Sonnet) to extract
    structured meeting notes from the transcript.

    Returns a dict matching EXTRACTION_SCHEMA.
    """
    import anthropic

    _load_env()
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        sys.exit("Error: ANTHROPIC_API_KEY not set in .env")

    client = anthropic.Anthropic(api_key=api_key)

    prompt = f"""You are analyzing the transcript of a meeting titled "{title}".

Extract the following from the transcript and return them as structured JSON:

1. **summary** — 3-5 bullet points covering the most important things discussed
2. **decisions** — Any explicit decisions or agreements reached (e.g. "We will use Figma for handoffs")
3. **action_items** — Tasks that someone committed to doing; include the owner's first name if mentioned, otherwise null
4. **key_topics** — 3-6 short topic phrases (e.g. "Q2 roadmap", "API design", "budget approval")

Be specific and factual. Do not invent details not present in the transcript.
If a section has nothing to report (e.g. no decisions were made), return an empty list.

TRANSCRIPT:
{transcript}"""

    response = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=2048,
        messages=[{"role": "user", "content": prompt}],
        output_config={
            "format": {
                "type": "json_schema",
                "schema": EXTRACTION_SCHEMA,
            }
        },
    )

    raw = next(b.text for b in response.content if b.type == "text")
    return json.loads(raw)


# ── Notion helpers ────────────────────────────────────────────────────────────

def _rich_text(text: str) -> list[dict]:
    return [{"type": "text", "text": {"content": text}}]


def _heading2(text: str) -> dict:
    return {"object": "block", "type": "heading_2",
            "heading_2": {"rich_text": _rich_text(text)}}


def _bullet(text: str) -> dict:
    return {"object": "block", "type": "bulleted_list_item",
            "bulleted_list_item": {"rich_text": _rich_text(text)}}


def _todo(text: str, checked: bool = False) -> dict:
    return {"object": "block", "type": "to_do",
            "to_do": {"rich_text": _rich_text(text), "checked": checked}}


def _divider() -> dict:
    return {"object": "block", "type": "divider", "divider": {}}


def _build_page_blocks(data: dict, attendees: list[str]) -> list[dict]:
    """Convert extracted meeting data into Notion block objects."""
    blocks: list[dict] = []

    # Attendees line
    if attendees:
        blocks.append(_bullet("👥 " + ", ".join(attendees)))
        blocks.append(_divider())

    # Summary
    blocks.append(_heading2("📋 Summary"))
    for point in data.get("summary", []):
        blocks.append(_bullet(point))

    # Key topics
    topics = data.get("key_topics", [])
    if topics:
        blocks.append(_divider())
        blocks.append(_heading2("🗂 Key Topics"))
        for topic in topics:
            blocks.append(_bullet(topic))

    # Decisions
    decisions = data.get("decisions", [])
    if decisions:
        blocks.append(_divider())
        blocks.append(_heading2("✅ Decisions"))
        for d in decisions:
            blocks.append(_bullet(d))

    # Action items (to_do checklist)
    action_items = data.get("action_items", [])
    if action_items:
        blocks.append(_divider())
        blocks.append(_heading2("⚡ Action Items"))
        for item in action_items:
            task = item["task"]
            owner = item.get("owner")
            label = f"{task} — {owner}" if owner else task
            blocks.append(_todo(label))

    # Attribution footer
    blocks.append(_divider())
    blocks.append({
        "object": "block",
        "type": "paragraph",
        "paragraph": {
            "rich_text": [{
                "type": "text",
                "text": {"content": "Created by Dot"},
                "annotations": {"italic": True, "color": "gray"},
            }]
        },
    })

    return blocks


def _find_writable_parent(notion_client) -> str | None:
    """
    Returns the Notion page ID to create meeting notes under.
    Uses NOTION_MEETINGS_PARENT_ID from .env if set (recommended).
    Falls back to searching for a titled page.
    """
    # 1. Explicit env var — always preferred
    pinned = os.environ.get("NOTION_MEETINGS_PARENT_ID", "").strip()
    if pinned:
        print(f"[summarize] Using pinned parent: {pinned}", file=sys.stderr)
        return pinned

    # 2. Search fallback
    try:
        resp = notion_client.search(page_size=50)
        pages = [r for r in resp.get("results", []) if r.get("object") == "page"]

        def page_title(p: dict) -> str:
            arr = (
                p.get("properties", {}).get("title", {}).get("title", [])
                or p.get("title", [])
            )
            return "".join(t.get("plain_text", "") for t in arr).strip().lower()

        for p in pages:
            if page_title(p):
                print(f"[summarize] Using parent: \"{page_title(p)}\" ({p['id']})", file=sys.stderr)
                return p["id"]

        if pages:
            return pages[0]["id"]

    except Exception as e:
        print(f"[summarize] Could not find writable parent: {e}", file=sys.stderr)
    return None


def save_to_notion(
    data: dict,
    title: str,
    attendees: list[str],
    meeting_date: str,
) -> str | None:
    """
    Create a standalone Notion page (not linked to any database) with
    structured meeting notes. Returns the page URL on success, None on failure.
    """
    _load_env()
    token = os.environ.get("NOTION_TOKEN", "")
    if not token:
        print("[summarize] NOTION_TOKEN not set — skipping save.", file=sys.stderr)
        return None

    try:
        from notion_client import Client
        notion = Client(auth=token)

        parent_id = _find_writable_parent(notion)
        if not parent_id:
            print("[summarize] No writable Notion page found — skipping save.", file=sys.stderr)
            return None

        blocks = _build_page_blocks(data, attendees)

        page = notion.pages.create(
            parent={"type": "page_id", "page_id": parent_id},
            properties={"title": {"title": _rich_text(f"{title} — {meeting_date}")}},
            children=blocks,
        )

        url = page.get("url", "")
        print(f"[summarize] Saved to Notion: {url}", file=sys.stderr)
        return url

    except Exception as e:
        print(f"[summarize] Failed to save to Notion: {e}", file=sys.stderr)
        return None


# ── text formatting ───────────────────────────────────────────────────────────

def format_summary(data: dict, title: str, meeting_date: str, attendees: list[str]) -> str:
    lines = [
        f"# {title}",
        f"Date: {meeting_date}",
    ]
    if attendees:
        lines.append(f"Attendees: {', '.join(attendees)}")
    lines.append("")

    lines.append("## Summary")
    for pt in data.get("summary", []):
        lines.append(f"  • {pt}")

    topics = data.get("key_topics", [])
    if topics:
        lines.append("")
        lines.append("## Key Topics")
        lines.append("  " + " · ".join(topics))

    decisions = data.get("decisions", [])
    if decisions:
        lines.append("")
        lines.append("## Decisions")
        for d in decisions:
            lines.append(f"  • {d}")

    action_items = data.get("action_items", [])
    if action_items:
        lines.append("")
        lines.append("## Action Items")
        for item in action_items:
            owner = f" ({item['owner']})" if item.get("owner") else ""
            lines.append(f"  [ ] {item['task']}{owner}")

    return "\n".join(lines)


# ── main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Summarize a meeting transcript with Claude")
    parser.add_argument("input", help="Transcript file path, or '-' to read from stdin")
    parser.add_argument("--title", default="Meeting Notes", help="Meeting title")
    parser.add_argument("--attendees", help="Comma-separated attendee names")
    parser.add_argument("--date", default=date.today().isoformat(), help="Meeting date (YYYY-MM-DD)")
    parser.add_argument("--no-save", action="store_true", help="Skip saving to Notion")
    args = parser.parse_args()

    # Read transcript
    if args.input == "-":
        transcript = sys.stdin.read().strip()
    else:
        p = Path(args.input)
        if not p.exists():
            sys.exit(f"Error: file not found: {args.input}")
        transcript = p.read_text().strip()

    if not transcript:
        sys.exit("Error: transcript is empty")

    # Resolve attendees
    if args.attendees:
        attendees = [a.strip() for a in args.attendees.split(",") if a.strip()]
    else:
        attendees = extract_attendees_from_transcript(transcript)

    print(f"[summarize] Extracting meeting notes with Claude Sonnet...", file=sys.stderr)
    data = extract_meeting_data(transcript, args.title)

    # Print formatted summary
    print(format_summary(data, args.title, args.date, attendees))

    # Save to Notion
    if not args.no_save:
        save_to_notion(data, args.title, attendees, args.date)


if __name__ == "__main__":
    main()
