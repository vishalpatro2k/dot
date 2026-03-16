import "./ContextBar.css";

interface Props {
  leftText: string;
  rightText?: string;
  statusColor: "green" | "red" | "yellow" | "gray";
}

export const ContextBar = ({ leftText, rightText, statusColor }: Props) => (
  <div className="context-bar">
    <span className={`ctx-dot ${statusColor}`} />
    <span className="ctx-left">{leftText}</span>
    {rightText && <span className="ctx-right">{rightText}</span>}
  </div>
);
