import React, { useRef } from "react";

export type DotState =
  | "idle"
  | "listening"
  | "recording"
  | "thinking"
  | "happy"
  | "alert"
  | "sleeping"
  | "processing";

interface DotProps {
  state: DotState;
  onClick: () => void;
  onDoubleClick: () => void;
  recordingTime?: number;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60).toString().padStart(2, "0");
  const s = (seconds % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

export default function Dot({ state, onClick, onDoubleClick, recordingTime = 0 }: DotProps) {
  const clickTimer  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clickCount  = useRef(0);

  const handleClick = () => {
    clickCount.current += 1;

    if (clickCount.current === 1) {
      // Wait to see if a second click arrives
      clickTimer.current = setTimeout(() => {
        clickCount.current = 0;
        onClick();
      }, 280);
    } else if (clickCount.current === 2) {
      if (clickTimer.current) {
        clearTimeout(clickTimer.current);
        clickTimer.current = null;
      }
      clickCount.current = 0;
      onDoubleClick();
    }
  };

  return (
    <div className="dot-container">
      <div
        className={`dot dot--${state}`}
        onClick={handleClick}
        title="Click to chat · Double-click to record"
      />
      {state === "recording" && (
        <span className="recording-timer">{formatTime(recordingTime)}</span>
      )}
    </div>
  );
}
