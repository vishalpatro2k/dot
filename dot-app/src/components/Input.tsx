import { useState, useRef, useEffect } from "react";
import "./Input.css";

interface InputProps {
  onSubmit: (message: string) => void;
  onClose: () => void;
  isLoading?: boolean;
}

export function Input({ onSubmit, onClose, isLoading }: InputProps) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 60);
    return () => clearTimeout(t);
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && value.trim() && !isLoading) {
      onSubmit(value.trim());
      setValue("");
    }
    if (e.key === "Escape") onClose();
  };

  return (
    <div className="input-wrapper">
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={isLoading ? "thinking…" : "ask dot…"}
        className="input-field"
        disabled={isLoading}
        autoComplete="off"
        spellCheck={false}
      />
    </div>
  );
}
