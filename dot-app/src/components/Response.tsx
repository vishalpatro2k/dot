import { useEffect } from "react";
import "./Response.css";

interface ResponseProps {
  text: string;
  onDismiss: () => void;
  isError?: boolean;
}

function stripMarkdown(raw: string): string {
  return raw
    .replace(/\*\*/g, "")
    .replace(/\*/g, "")
    .replace(/^#{1,3}\s*/gm, "")
    .replace(/^[-•]\s+/gm, "")
    .replace(/:\*\*/g, ":")
    .replace(/\*\*:/g, ":");
}

function formatText(raw: string) {
  const cleaned = stripMarkdown(raw);

  return cleaned.split("\n").map((line, i) => {
    const trimmed = line.trim();

    if (!trimmed) return <div key={i} className="spacer" />;

    // 💡 Insight line
    if (trimmed.startsWith("💡")) {
      return (
        <div key={i} className="insight-box">
          <span className="insight-icon">💡</span>
          <span className="insight-text">{trimmed.slice(2).trim()}</span>
        </div>
      );
    }

    // Time → Event with optional [tag]: "10:30 → Meeting [break]"
    const timeMatch = trimmed.match(/^(\d{1,2}:\d{2})\s*[→\-–—]\s*(.+?)(?:\s*\[([\w\s]+)\])?$/);
    if (timeMatch) {
      const [, time, event, tag] = timeMatch;
      const tagSlug = tag ? tag.toLowerCase().replace(/\s+/g, "-") : undefined;
      return (
        <div key={i} className="event-row">
          <span className="event-time">{time}</span>
          <span className="event-text">{event}</span>
          {tag && <span className={`event-tag tag-${tagSlug}`}>{tag}</span>}
        </div>
      );
    }

    // Name → Subject [tag] (time ago) — email rows (no leading timestamp)
    const emailMatch = trimmed.match(/^(.+?)\s*[→]\s*(.+?)(?:\s*\[([\w\s]+)\])?(?:\s*\(([^)]+)\))?$/);
    if (emailMatch && !trimmed.match(/^\d{1,2}:\d{2}/)) {
      const [, sender, subject, tag, ago] = emailMatch;
      const tagSlug = tag ? tag.toLowerCase().replace(/\s+/g, "-") : undefined;
      return (
        <div key={i} className="event-row">
          <span className="event-text" style={{ fontWeight: 500 }}>{sender.trim()}</span>
          <span className="event-text" style={{ opacity: 0.75, flex: 2 }}>{subject.trim()}</span>
          {tag && <span className={`event-tag tag-${tagSlug}`}>{tag}</span>}
          {ago && <span className="event-time" style={{ minWidth: "unset" }}>{ago}</span>}
        </div>
      );
    }

    // Section headers: "Morning:", "Afternoon:" etc.
    if (/^(morning|afternoon|evening|tonight|tomorrow|today)s?:?\s*$/i.test(trimmed)) {
      return (
        <div key={i} className="section-header">
          {trimmed.replace(/:$/, "")}
        </div>
      );
    }

    // Numbered items: "1. text" or "1) text"
    const numMatch = trimmed.match(/^(\d+)[.)]\s+(.+)/);
    if (numMatch) {
      return (
        <div key={i} className="numbered-row">
          <span className="num">{numMatch[1]}.</span>
          <span className="num-text">{numMatch[2]}</span>
        </div>
      );
    }

    return <div key={i} className="text-line">{trimmed}</div>;
  });
}

export function Response({ text, onDismiss, isError }: ResponseProps) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onDismiss]);

  return (
    <div
      className={`response${isError ? " response--error" : ""}`}
      onClick={onDismiss}
      title="Click or Esc to dismiss"
    >
      <div className="response-content">
        {formatText(text)}
      </div>
    </div>
  );
}
