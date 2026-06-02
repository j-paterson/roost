import { useState, useCallback, useEffect } from "react";
import type { IRoostPlugin } from "@/types/plugin";

export function useRoostSidebarLog(plugin: IRoostPlugin) {
  const [logs, setLogs] = useState<string[]>([]);
  const [showLogs, setShowLogs] = useState(false);

  const log = useCallback((msg: string) => {
    setLogs((prev) => {
      const next = [...prev, `${new Date().toLocaleTimeString()} ${msg}`];
      return next.length > 500 ? next.slice(-500) : next;
    });
    setShowLogs(true);
  }, []);

  useEffect(() => plugin.onLog(log), [plugin, log]);

  return { logs, showLogs, setShowLogs, log };
}
