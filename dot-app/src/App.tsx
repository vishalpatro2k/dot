import { useState, useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { Dot } from "./components/Dot";
import { Input } from "./components/Input";
import { ThinkingText } from "./components/ThinkingText";
import { Response } from "./components/Response";
import { sendChat, stopRecording as apiStopRecording, getStatus } from "./api";
import "./styles.css";

type AppState = "idle" | "listening" | "recording" | "thinking" | "happy" | "sleeping";

const WIN_COLLAPSED = new LogicalSize(400, 200);
const WIN_EXPANDED  = new LogicalSize(480, 520);

function App() {
  const [state, setState] = useState<AppState>("idle");
  const [response, setResponse] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const pipelinePoller = useRef<number | null>(null);

  // Position window at top-center on first load
  useEffect(() => {
    const w = getCurrentWindow();
    const x = Math.floor(window.screen.width / 2 - 200);
    w.setPosition(new LogicalPosition(x, 24)).catch(() => {});
  }, []);

  // Expand/collapse window based on state
  useEffect(() => {
    const expanded = !!response || state === "listening";
    const size = expanded ? WIN_EXPANDED : WIN_COLLAPSED;
    const x = Math.floor(window.screen.width / 2 - size.width / 2);
    const w = getCurrentWindow();
    w.setSize(size).catch(() => {});
    w.setPosition(new LogicalPosition(x, 24)).catch(() => {});
  }, [response, state]);

  // Recording timer
  useEffect(() => {
    if (state !== "recording") {
      setRecordingTime(0);
      return;
    }
    const interval = window.setInterval(() => setRecordingTime((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, [state]);

  // Idle → Sleeping after 5 minutes
  useEffect(() => {
    if (state !== "idle") return;
    let elapsed = 0;
    const interval = window.setInterval(() => {
      elapsed += 1;
      if (elapsed >= 300) {
        setState("sleeping");
        clearInterval(interval);
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [state]);

  // Clean up pipeline poller on unmount
  useEffect(() => {
    return () => {
      if (pipelinePoller.current) clearInterval(pipelinePoller.current);
    };
  }, []);

  const showResponse = (text: string, error = false) => {
    setResponse(text);
    setIsError(error);
  };

  const stopRecordingAndPoll = async () => {
    setState("thinking");

    try {
      await apiStopRecording();
    } catch (err: any) {
      showResponse(err?.message ?? "Failed to stop recording.", true);
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

          if (s.lastError) {
            showResponse(s.lastError, true);
            setState("idle");
          } else {
            showResponse(s.lastSummary || "Meeting saved to Notion.");
            setState("happy");
            setTimeout(() => setState("idle"), 4000);
          }
        }
      } catch {
        if (attempts >= 24) {
          clearInterval(pipelinePoller.current!);
          pipelinePoller.current = null;
          showResponse("Pipeline timed out. Check server logs.", true);
          setState("idle");
        }
      }
    }, 2500);
  };

  const handleDotClick = () => {
    if (state === "sleeping") { setState("idle"); return; }
    if (state === "recording") { stopRecordingAndPoll(); return; }
    if (state === "idle") setState("listening");
  };

  const handleLongPress = () => {
    if (state === "recording") {
      stopRecordingAndPoll();
    } else if (state !== "thinking") {
      setState("recording");
    }
  };

  const handleSubmit = async (message: string) => {
    setState("thinking");
    try {
      const data = await sendChat(message);
      showResponse(data.answer);
      setState("happy");
    } catch (err: any) {
      showResponse(err?.message ?? "Could not connect to Dot server.", true);
      setState("idle");
    }
  };

  const handleClose = () => {
    setState("idle");
    setResponse(null);
    setIsError(false);
  };

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60).toString().padStart(2, "0");
    const s = (seconds % 60).toString().padStart(2, "0");
    return `${m}:${s}`;
  };

  return (
    <div className="app">
      <Dot state={state} onClick={handleDotClick} onLongPress={handleLongPress} />

      {state === "thinking" && <ThinkingText />}

      {state === "recording" && (
        <div className="recording-info">
          <span className="rec-dot" />
          <span className="rec-time">{formatTime(recordingTime)}</span>
        </div>
      )}

      {state === "listening" && (
        <Input onSubmit={handleSubmit} onClose={handleClose} />
      )}

      {response && (state === "happy" || state === "idle") && (
        <Response text={response} onDismiss={handleClose} isError={isError} />
      )}

      {state === "idle" && !response && (
        <span className="hint">click to ask · hold to record</span>
      )}
    </div>
  );
}

export default App;
