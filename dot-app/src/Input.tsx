import React, { useEffect, useRef, useState } from "react";

interface InputProps {
  onSubmit: (message: string) => void;
  onClose: () => void;
  response?: string;
  isLoading?: boolean;
}

export default function Input({ onSubmit, onClose, response, isLoading }: InputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");

  useEffect(() => {
    // Small delay so the animation finishes before focus
    const t = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (value.trim() && !isLoading) {
      onSubmit(value.trim());
      setValue("");
    }
  };

  return (
    <div className="input-wrapper">
      <form onSubmit={handleSubmit}>
        <div className="input-area">
          <input
            ref={inputRef}
            className="dot-input"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={isLoading ? "thinking…" : "ask dot…"}
            disabled={isLoading}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
      </form>
      {response && (
        <div className="dot-response">{response}</div>
      )}
    </div>
  );
}
