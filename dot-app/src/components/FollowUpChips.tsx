import "./FollowUpChips.css";

export interface Suggestion {
  id: string;
  label: string;
  query: string;
  icon?: string;
  type: "action" | "question" | "navigation";
}

interface Props {
  suggestions: Suggestion[];
  onSelect: (s: Suggestion) => void;
}

export const FollowUpChips = ({ suggestions, onSelect }: Props) => (
  <div className="follow-up-chips">
    {suggestions.map((s) => (
      <button key={s.id} className="chip" onClick={() => onSelect(s)}>
        {s.icon && <span className="chip-icon">{s.icon}</span>}
        <span>{s.label}</span>
      </button>
    ))}
  </div>
);
