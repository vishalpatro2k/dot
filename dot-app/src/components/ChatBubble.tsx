import "./ChatBubble.css";

interface Props {
  role: "user" | "assistant";
  content: string;
}

function formatContent(text: string) {
  const lines = text.split("\n");
  return lines.map((line, i) => {
    const t = line.trim();
    if (!t) return <div key={i} className="spacer" />;

    // Time → Event  (e.g. "10:30 → Standup")
    const timeMatch = t.match(/^(\d{1,2}:\d{2}(?:\s*[ap]m)?)\s*[→\-]\s*(.+)/i);
    if (timeMatch) {
      return (
        <div key={i} className="event-line">
          <span className="event-time">{timeMatch[1]}</span>
          <span className="event-text">{timeMatch[2]}</span>
        </div>
      );
    }

    // Insight lines
    if (t.startsWith("💡")) {
      return <div key={i} className="insight-line">{t}</div>;
    }

    return <div key={i} className="text-line">{t}</div>;
  });
}

export const ChatBubble = ({ role, content }: Props) => (
  <div className={`chat-bubble ${role}`}>
    {formatContent(content)}
  </div>
);
