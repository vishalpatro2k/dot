import "./QuickActions.css";
import type { Suggestion } from "./FollowUpChips.js";

interface Props {
  actions: Suggestion[];
  onSelect: (a: Suggestion) => void;
}

export const QuickActions = ({ actions, onSelect }: Props) => (
  <div className="quick-actions">
    {actions.map((a) => (
      <button key={a.id} className="quick-action" onClick={() => onSelect(a)}>
        <span className="qa-icon">{a.icon}</span>
        <span className="qa-label">{a.label}</span>
      </button>
    ))}
  </div>
);
