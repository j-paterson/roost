/**
 * Collapsible log panel — shows sync/pipeline activity.
 */
import { useRef, useEffect } from "react";
import { Notice } from "obsidian";

interface LogPanelProps {
  logs: string[];
  showLogs: boolean;
  onToggle: () => void;
  syncing: boolean;
}

export function LogPanel({ logs, showLogs, onToggle, syncing }: LogPanelProps) {
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  if (logs.length === 0) return null;

  return (
    <div className="shrink-0 border-t border-border flex flex-col">
      <button
        className="flex items-center gap-2 px-3 py-1 text-xs text-muted-foreground hover:text-foreground bg-card cursor-pointer"
        onClick={onToggle}
      >
        <span>{showLogs ? "▾" : "▸"}</span>
        <span>Logs</span>
        {syncing && <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />}
        <span className="flex-1" />
        <span>{logs.length}</span>
        {showLogs && (
          <>
            <span
              className="hover:text-foreground cursor-pointer"
              onClick={(e) => {
                e.stopPropagation();
                navigator.clipboard.writeText(logs.join("\n"));
                new Notice("Logs copied to clipboard");
              }}
              title="Copy logs"
            >⎘</span>
            <span
              className="hover:text-foreground cursor-pointer"
              onClick={(e) => {
                e.stopPropagation();
                const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
                const blob = new Blob([logs.join("\n")], { type: "text/plain" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `roost-logs-${ts}.txt`;
                a.click();
                URL.revokeObjectURL(url);
                new Notice(`Saved ${logs.length} lines`);
              }}
              title="Save logs to file"
            >⭳</span>
          </>
        )}
      </button>
      {showLogs && (
        <div className="max-h-[200px] overflow-y-auto px-3 py-1 font-mono text-xs text-muted-foreground bg-card">
          {logs.slice(-50).map((line, i) => <div key={i}>{line}</div>)}
          <div ref={logEndRef} />
        </div>
      )}
    </div>
  );
}
