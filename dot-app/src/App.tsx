import { useState, useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { Dot } from "./components/Dot";
import { Input } from "./components/Input";
import { ChatBubble } from "./components/ChatBubble";
import { ContextBar } from "./components/ContextBar";
import { FollowUpChips, type Suggestion } from "./components/FollowUpChips";
import { QuickActions } from "./components/QuickActions";
import { getStatus } from "./api";
import "./styles.css";

type AppState = "idle" | "listening" | "recording" | "thinking" | "happy" | "sleeping";

interface Message {
  role: "user" | "assistant";
  content: string;
}

interface ContextBarState {
  leftText: string;
  rightText?: string;
  status: string;
  statusColor: "green" | "red" | "yellow" | "gray";
}

const BASE = "http://localhost:3000";

const WIN_COLLAPSED = new LogicalSize(420, 200);
const WIN_CHAT      = new LogicalSize(480, 580);

async function apiChat(message: string): Promise<{ answer: string; model: string; suggestions?: Suggestion[] }> {
  const res = await fetch(`${BASE}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

async function apiContext(): Promise<{ contextBar: ContextBarState; quickActions: Suggestion[] }> {
  const res = await fetch(`${BASE}/context`);
  if (!res.ok) throw new Error("context unavailable");
  return res.json();
}

function App() {
  const [state, setState] = useState<AppState>("idle");
  const [messages, setMessages] = useState<Message[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [contextBar, setContextBar] = useState<ContextBarState | null>(null);
  const [quickActions, setQuickActions] = useState<Suggestion[]>([]);
  const [chatOpen, setChatOpen] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const pipelinePoller = useRef<number | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Window sizing
  useEffect(() => {
    const w = getCurrentWindow();
    const size = chatOpen ? WIN_CHAT : WIN_COLLAPSED;
    const x = Math.floor(window.screen.width / 2 - size.width / 2);
    w.setSize(size).catch(() => {});
    w.setPosition(new LogicalPosition(x, 24)).catch(() => {});
  }, [chatOpen]);

  // Initial window position
  useEffect(() => {
    const w = getCurrentWindow();
    const x = Math.floor(window.screen.width / 2 - WIN_COLLAPSED.width / 2);
    w.setPosition(new LogicalPosition(x, 24)).catch(() => {});
  }, []);

  // Fetch context bar every 30s
  useEffect(() => {
    const refresh = () => {
      apiContext().then((d) => {
        setContextBar(d.contextBar);
        setQuickActions(d.quickActions);
      }).catch(() => {});
    };
    refresh();
    const id = setInterval(refresh, 30_000);
    return () => clearInterval(id);
  }, []);

  // Scroll to latest message
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, state]);

  // Idle → sleeping after 5min
  useEffect(() => {
    if (state !== "idle" || chatOpen) return;
    let elapsed = 0;
    const id = setInterval(() => { elapsed++; if (elapsed >= 300) { setState("sleeping"); clearInterval(id); } }, 1000);
    return () => clearInterval(id);
  }, [state, chatOpen]);

  // Recording timer
  useEffect(() => {
    if (state !== "recording") { setRecordingTime(0); return; }
    const id = setInterval(() => setRecordingTime((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [state]);

  useEffect(() => () => { if (pipelinePoller.current) clearInterval(pipelinePoller.current); }, []);

  const handleSubmit = async (message: string) => {
    if (!message.trim()) return;
    setState("thinking");
    setSuggestions([]);
    setMessages((prev) => [...prev, { role: "user", content: message }]);

    try {
      const data = await apiChat(message);
      setMessages((prev) => [...prev, { role: "assistant", content: data.answer }]);
      setSuggestions(data.suggestions ?? []);
      setState("happy");
    } catch (err: any) {
      setMessages((prev) => [...prev, { role: "assistant", content: err?.message ?? "Could not connect to Dot server." }]);
      setState("idle");
    }
  };

  const handleSuggestionClick = (s: Suggestion) => {
    if (s.query.endsWith(": ")) {
      // Partial query — just open input focused; handled by Input component placeholder
      setState("listening");
    } else {
      handleSubmit(s.query);
    }
  };

  const handleDotClick = () => {
    if (state === "sleeping") { setState("idle"); return; }
    if (state === "recording") { stopRecordingAndPoll(); return; }
    if (!chatOpen) { setChatOpen(true); setState("listening"); return; }
    if (state === "idle" || state === "happy") setState("listening");
  };

  const handleLongPress = () => {
    if (state === "recording") { stopRecordingAndPoll(); }
    else if (state !== "thinking") { setState("recording"); }
  };

  const handleClose = () => {
    setState("idle");
    setChatOpen(false);
  };

  const stopRecordingAndPoll = async () => {
    setState("thinking");
    try {
      await fetch(`${BASE}/recording/stop`, { method: "POST" });
    } catch (err: any) {
      setMessages((prev) => [...prev, { role: "assistant", content: err?.message ?? "Failed to stop recording." }]);
      setState("idle");
      return;
    }

    let attempts = 0;
    pipelinePoller.current = window.setInterval(async () => {
      attempts++;
      try {
        const s = await getStatus();
        if (s.state !== "processing") {
          clearInterval(pipelinePoller.current!);
          pipelinePoller.current = null;
          const text = s.lastError ?? s.lastSummary ?? "Meeting saved to Notion.";
          setMessages((prev) => [...prev, { role: "assistant", content: text }]);
          setState(s.lastError ? "idle" : "happy");
        }
      } catch {
        if (attempts >= 24) {
          clearInterval(pipelinePoller.current!);
          setMessages((prev) => [...prev, { role: "assistant", content: "Pipeline timed out. Check server logs." }]);
          setState("idle");
        }
      }
    }, 2500);
  };

  const formatTime = (s: number) =>
    `${Math.floor(s / 60).toString().padStart(2, "0")}:${(s % 60).toString().padStart(2, "0")}`;

  return (
    <div className="app">
      {/* Context bar — shown when collapsed */}
      {!chatOpen && contextBar && (
        <ContextBar
          leftText={contextBar.leftText}
          rightText={contextBar.rightText}
          statusColor={contextBar.statusColor}
        />
      )}

      {/* Dot orb */}
      <Dot state={state} onClick={handleDotClick} onLongPress={handleLongPress} />

      {/* Recording indicator */}
      {state === "recording" && (
        <div className="recording-info">
          <span className="rec-dot" />
          <span className="rec-time">{formatTime(recordingTime)}</span>
        </div>
      )}

      {/* ── Chat panel ─────────────────────────────────────────────────── */}
      {chatOpen && (
        <div className="chat-panel">
          <div className="messages-list">
            {messages.map((m, i) => (
              <ChatBubble key={i} role={m.role} content={m.content} />
            ))}

            {state === "thinking" && (
              <div className="typing-indicator">
                <span className="typing-dot" />
                <span className="typing-dot" />
                <span className="typing-dot" />
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {suggestions.length > 0 && state !== "thinking" && (
            <FollowUpChips suggestions={suggestions} onSelect={handleSuggestionClick} />
          )}

          {(state === "listening" || state === "idle" || state === "happy") && (
            <Input onSubmit={handleSubmit} onClose={handleClose} />
          )}
        </div>
      )}

      {/* Quick actions — shown when collapsed */}
      {!chatOpen && quickActions.length > 0 && state !== "sleeping" && (
        <QuickActions actions={quickActions} onSelect={(a) => { setChatOpen(true); handleSubmit(a.query); }} />
      )}

      {/* Collapsed hint */}
      {!chatOpen && state === "idle" && !contextBar && (
        <span className="hint">click to ask · hold to record</span>
      )}
    </div>
  );
}

export default App;
