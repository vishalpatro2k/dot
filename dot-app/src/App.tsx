import React, { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize, LogicalPosition } from "@tauri-apps/api/dpi";
import { listen } from "@tauri-apps/api/event";
import Dot, { DotState } from "./Dot";
import Input from "./Input";
import { sendChat, startRecording, stopRecording, getStatus } from "./api";

const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const COLLAPSED_SIZE  = new LogicalSize(160, 60);
const STATUS_SIZE     = new LogicalSize(200, 86);
const EXPANDED_SIZE   = new LogicalSize(280, 160);

export default function App() {
  const [dotState, setDotState]           = useState<DotState>("idle");
  const [isExpanded, setIsExpanded]       = useState(false);
  const [response, setResponse]           = useState<string | undefined>();
  const [isLoading, setIsLoading]         = useState(false);
  const [isRecording, setIsRecording]     = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [statusText, setStatusText]       = useState<string>("");
  const [statusDone, setStatusDone]       = useState(false);

  const idleTimer      = useRef<ReturnType<typeof setTimeout>  | null>(null);
  const recordTimer    = useRef<ReturnType<typeof setInterval> | null>(null);
  const pipelinePoller = useRef<ReturnType<typeof setInterval> | null>(null);
  const containerRef   = useRef<HTMLDivElement>(null);
  const isSleeping     = useRef(false);

  // ── window: place near menubar on first load ───────────────────────────────
  useEffect(() => {
    const x = Math.floor(window.screen.width / 2 - 80);
    getCurrentWindow().setPosition(new LogicalPosition(x, 10)).catch(() => {});
  }, []);

  // ── idle / sleeping ────────────────────────────────────────────────────────
  const resetIdle = useCallback(() => {
    if (idleTimer.current) clearTimeout(idleTimer.current);
    if (isSleeping.current) {
      isSleeping.current = false;
      setDotState("idle");
    }
    idleTimer.current = setTimeout(() => {
      isSleeping.current = true;
      setDotState("sleeping");
    }, IDLE_TIMEOUT_MS);
  }, []);

  useEffect(() => {
    resetIdle();
    const wake = () => resetIdle();
    window.addEventListener("mousemove", wake);
    window.addEventListener("keydown", wake);
    return () => {
      window.removeEventListener("mousemove", wake);
      window.removeEventListener("keydown", wake);
      if (idleTimer.current) clearTimeout(idleTimer.current);
    };
  }, [resetIdle]);

  // ── global hotkey ⌘⇧D ─────────────────────────────────────────────────────
  useEffect(() => {
    let cleanup: (() => void) | undefined;
    listen<null>("toggle-input", () => {
      resetIdle();
      setIsExpanded((prev) => {
        const next = !prev;
        getCurrentWindow().setSize(next ? EXPANDED_SIZE : COLLAPSED_SIZE).catch(() => {});
        if (!next) setResponse(undefined);
        return next;
      });
    }).then((fn) => { cleanup = fn; });
    return () => cleanup?.();
  }, [resetIdle]);

  // ── click outside → collapse ───────────────────────────────────────────────
  useEffect(() => {
    if (!isExpanded) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        collapse();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [isExpanded]);

  // ── server status polling (nudges + sync recording state) ─────────────────
  useEffect(() => {
    const poll = setInterval(async () => {
      try {
        const s = await getStatus();
        if (s.hasNudges && !isLoading && !isRecording && !isSleeping.current) {
          setDotState("alert");
        }
      } catch { /* server offline */ }
    }, 15_000);
    return () => clearInterval(poll);
  }, [isLoading, isRecording]);

  // ── recording timer ────────────────────────────────────────────────────────
  useEffect(() => {
    if (isRecording) {
      setRecordingTime(0);
      recordTimer.current = setInterval(() => setRecordingTime((t) => t + 1), 1000);
    } else {
      if (recordTimer.current) clearInterval(recordTimer.current);
    }
    return () => { if (recordTimer.current) clearInterval(recordTimer.current); };
  }, [isRecording]);

  // ── pipeline result poller — runs after recording stops ───────────────────
  const startPipelinePolling = useCallback(() => {
    if (pipelinePoller.current) clearInterval(pipelinePoller.current);

    setStatusText("processing…");
    setStatusDone(false);
    getCurrentWindow().setSize(STATUS_SIZE).catch(() => {});

    pipelinePoller.current = setInterval(async () => {
      try {
        const s = await getStatus();
        if (s.state !== "processing") {
          clearInterval(pipelinePoller.current!);
          pipelinePoller.current = null;

          // Show done banner
          setStatusText(s.lastError ? "✗ pipeline error" : "✓ saved to Notion");
          setStatusDone(!s.lastError);
          setDotState("happy");

          // After 2.5s: if there's a summary open it, otherwise collapse back
          setTimeout(() => {
            const text = s.lastSummary || s.lastError || null;
            if (text) {
              setResponse(text);
              setIsExpanded(true);
              setStatusText("");
              getCurrentWindow().setSize(EXPANDED_SIZE).catch(() => {});
            } else {
              setStatusText("");
              getCurrentWindow().setSize(COLLAPSED_SIZE).catch(() => {});
            }
            setDotState("idle");
          }, 2500);
        }
      } catch { /* ignore */ }
    }, 2500);
  }, []);

  // ── helpers ────────────────────────────────────────────────────────────────
  const collapse = () => {
    setIsExpanded(false);
    setResponse(undefined);
    setStatusText("");
    getCurrentWindow().setSize(COLLAPSED_SIZE).catch(() => {});
  };

  // ── dot click ──────────────────────────────────────────────────────────────
  const handleDotClick = () => {
    if (isLoading) return;
    resetIdle();
    if (isSleeping.current) return;

    const next = !isExpanded;
    setIsExpanded(next);
    getCurrentWindow().setSize(next ? EXPANDED_SIZE : COLLAPSED_SIZE).catch(() => {});
    if (next) {
      setDotState("listening");
    } else {
      setResponse(undefined);
      if (!isRecording) setDotState("idle");
    }
  };

  // ── double-click → toggle recording ───────────────────────────────────────
  const handleDoubleClick = async () => {
    resetIdle();
    if (isRecording) {
      // stop
      setIsRecording(false);
      setDotState("thinking");
      try {
        await stopRecording();
        startPipelinePolling();
      } catch (err) {
        console.error("stop recording failed:", err);
        setStatusText("✗ server not running");
        setStatusDone(false);
        getCurrentWindow().setSize(STATUS_SIZE).catch(() => {});
        setTimeout(() => {
          setStatusText("");
          getCurrentWindow().setSize(COLLAPSED_SIZE).catch(() => {});
        }, 3000);
        setDotState("idle");
      }
    } else {
      // start
      setIsRecording(true);
      try {
        await startRecording();
      } catch {
        setIsRecording(false);
        setStatusText("✗ server not running");
        setStatusDone(false);
        getCurrentWindow().setSize(STATUS_SIZE).catch(() => {});
        setTimeout(() => {
          setStatusText("");
          getCurrentWindow().setSize(COLLAPSED_SIZE).catch(() => {});
        }, 3000);
        setDotState("idle");
      }
    }
  };

  // ── chat submit ────────────────────────────────────────────────────────────
  const handleSubmit = async (message: string) => {
    resetIdle();
    setIsLoading(true);
    setDotState("thinking");
    setResponse(undefined);
    try {
      const data = await sendChat(message);
      setResponse(data.answer);
      setDotState("happy");
      setTimeout(() => setDotState("listening"), 1800);
    } catch {
      setResponse("couldn't reach dot server — is `npm run server` running?");
      setDotState("alert");
      setTimeout(() => setDotState("listening"), 2500);
    } finally {
      setIsLoading(false);
    }
  };

  // ── ⌥ drag to reposition ──────────────────────────────────────────────────
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.altKey && e.button === 0) {
      e.preventDefault();
      getCurrentWindow().startDragging().catch(() => {});
    }
  };

  const effectiveState: DotState = isRecording ? "recording" : dotState;

  return (
    <div ref={containerRef} className="app" onMouseDown={handleMouseDown}>
      <Dot
        state={effectiveState}
        onClick={handleDotClick}
        onDoubleClick={handleDoubleClick}
        recordingTime={recordingTime}
      />
      {statusText && (
        <div className={`status-label ${statusDone ? "status-label--done" : ""}`}>
          {statusText}
        </div>
      )}
      {isExpanded && (
        <Input
          onSubmit={handleSubmit}
          onClose={collapse}
          response={response}
          isLoading={isLoading || dotState === "thinking"}
        />
      )}
    </div>
  );
}
