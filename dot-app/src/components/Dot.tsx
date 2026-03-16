import { useRef, useCallback } from "react";
import "./Dot.css";

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
  onLongPress: () => void;
}

export function Dot({ state, onClick, onLongPress }: DotProps) {
  const timerRef    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const didLongPress = useRef(false);

  const handleMouseDown = useCallback(() => {
    didLongPress.current = false;
    timerRef.current = setTimeout(() => {
      didLongPress.current = true;
      onLongPress();
    }, 800);
  }, [onLongPress]);

  const handleMouseUp = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (!didLongPress.current) onClick();
  }, [onClick]);

  const handleMouseLeave = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  return (
    <div
      className={`dot ${state}`}
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseLeave}
      title="Click to chat · Hold to record"
    />
  );
}
