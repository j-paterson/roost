import { useState } from "react";
import { Button } from "@/ui/components/ui/button";
import { Input } from "@/ui/components/ui/input";

export interface SuggestedTopic {
  name: string;
  count: number;
}

interface TopicEditorProps {
  topics: string[];
  onTopicsChange: (topics: string[]) => void;
  onRun: () => void;
  onCancel: () => void;
  /** Optional pre-flight suggestions surfaced from item LLM categories. */
  suggestedTopics?: SuggestedTopic[];
}

export function TopicEditor({ topics, onTopicsChange, onRun, onCancel, suggestedTopics }: TopicEditorProps) {
  const [input, setInput] = useState("");

  function addTopic(name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (topics.some(t => t.toLowerCase() === trimmed.toLowerCase())) return;
    onTopicsChange([...topics, trimmed]);
  }

  function addFromInput() {
    addTopic(input);
    setInput("");
  }

  function removeTopic(topic: string) {
    onTopicsChange(topics.filter(t => t !== topic));
  }

  const visibleSuggestions = (suggestedTopics ?? []).filter(
    s => !topics.some(t => t.toLowerCase() === s.name.toLowerCase()),
  );

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Header */}
      <div className="px-3 pt-3 pb-2 shrink-0">
        <h2 className="text-sm font-medium">Define Topics</h2>
        <p className="text-xs text-muted-foreground mt-1">
          Topics guide categorization. Toggle off any you don't want.
        </p>
      </div>

      {/* Add input */}
      <div className="flex gap-1.5 px-3 pb-2 shrink-0">
        <Input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") addFromInput(); }}
          placeholder="Add a topic..."
          className="flex-1 h-7 text-xs"
        />
        <Button variant="outline" size="sm" onClick={addFromInput} disabled={!input.trim()}>Add</Button>
      </div>

      {/* Topic list — scrollable */}
      <div className="flex-1 overflow-y-auto min-h-0 px-1">
        {topics.length === 0 ? (
          <div className="px-3 py-4 text-xs text-muted-foreground italic text-center">
            No topics — clustering will discover categories automatically
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-x-1">
            {topics.map(topic => (
              <div
                key={topic}
                className="flex items-center gap-2 px-2 py-1 rounded cursor-pointer hover:bg-[var(--background-modifier-hover)] text-xs group"
                onClick={() => removeTopic(topic)}
              >
                <span className="text-[var(--interactive-accent)] shrink-0">✓</span>
                <span className="truncate flex-1">{topic}</span>
                <span className="text-[var(--text-faint)] opacity-0 group-hover:opacity-100 shrink-0">✕</span>
              </div>
            ))}
          </div>
        )}

        {/* Suggestions section — appears below selected topics. */}
        {visibleSuggestions.length > 0 && (
          <div className="px-3 pt-3 pb-2 border-t border-border mt-2">
            <div className="text-xs text-muted-foreground mb-1.5">
              Suggested from items being sorted:
            </div>
            <div className="flex flex-wrap gap-1">
              {visibleSuggestions.map(s => (
                <button
                  key={s.name}
                  type="button"
                  onClick={() => addTopic(s.name)}
                  className="text-xs px-2 py-0.5 rounded border border-border hover:bg-[var(--background-modifier-hover)] cursor-pointer"
                  title={`Add "${s.name}" (${s.count} items)`}
                >
                  + {s.name} <span className="text-[var(--text-faint)]">({s.count})</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex gap-2 px-3 py-2 border-t border-border shrink-0">
        <Button size="sm" className="flex-1" onClick={onRun}>
          Run{topics.length > 0 ? ` (${topics.length} topics)` : ""}
        </Button>
        <Button variant="outline" size="sm" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}
