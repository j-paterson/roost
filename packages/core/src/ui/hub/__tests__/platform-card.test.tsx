// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { PlatformCard } from "@/ui/hub/platform-card";

afterEach(cleanup);

describe("PlatformCard — unconfigured", () => {
  it("shows Connect button and educational copy", () => {
    const onConnect = vi.fn();
    render(<PlatformCard platform="tiktok" state={{ kind: "unconfigured" }} onConnect={onConnect} onSync={() => {}} onReconnect={() => {}} />);
    expect(screen.getByText(/connect/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /connect/i }));
    expect(onConnect).toHaveBeenCalledOnce();
  });
});

describe("PlatformCard — connected-idle", () => {
  it("shows item count, last-sync, and Sync button", () => {
    const onSync = vi.fn();
    const ts = Date.now() - 2 * 60 * 60 * 1000;
    render(
      <PlatformCard
        platform="tiktok"
        state={{ kind: "connected-idle", itemCount: 4732, lastSync: ts, backlogs: { mediaFiles: 0, thread: 0, articleBody: 0, playback: 0 } }}
        onConnect={() => {}}
        onSync={onSync}
        onReconnect={() => {}}
      />
    );
    expect(screen.getByText(/4,732/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /sync/i }));
    expect(onSync).toHaveBeenCalledOnce();
  });

  it("renders a Disconnect button when onDisconnect is provided and fires it", () => {
    const onDisconnect = vi.fn();
    render(
      <PlatformCard
        platform="tiktok"
        state={{ kind: "connected-idle", itemCount: 10, lastSync: Date.now(), backlogs: { mediaFiles: 0, thread: 0, articleBody: 0, playback: 0 } }}
        onConnect={() => {}}
        onSync={() => {}}
        onReconnect={() => {}}
        onDisconnect={onDisconnect}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /disconnect/i }));
    expect(onDisconnect).toHaveBeenCalledOnce();
  });

  it("omits the Disconnect button when onDisconnect is not provided", () => {
    render(
      <PlatformCard
        platform="tiktok"
        state={{ kind: "connected-idle", itemCount: 10, lastSync: Date.now(), backlogs: { mediaFiles: 0, thread: 0, articleBody: 0, playback: 0 } }}
        onConnect={() => {}}
        onSync={() => {}}
        onReconnect={() => {}}
      />
    );
    expect(screen.queryByRole("button", { name: /disconnect/i })).toBeNull();
  });

  it("renders backlog rows for non-zero buckets", () => {
    render(
      <PlatformCard
        platform="x"
        state={{
          kind: "connected-idle",
          itemCount: 1184,
          lastSync: Date.now(),
          backlogs: { mediaFiles: 0, thread: 4, articleBody: 28, playback: 0 },
        }}
        onConnect={() => {}}
        onSync={() => {}}
        onReconnect={() => {}}
      />
    );
    // Backlog rows render the count in a styled span and the label in
    // surrounding text — getByText doesn't see split text by default,
    // so we walk the container.
    const matchPartialText = (substr: string) => (_content: string, node: Element | null) => {
      return node !== null && (node.textContent ?? "").toLowerCase().includes(substr.toLowerCase());
    };
    expect(screen.getAllByText(matchPartialText("4 threads incomplete")).length).toBeGreaterThan(0);
    expect(screen.getAllByText(matchPartialText("28 article bodies")).length).toBeGreaterThan(0);
  });
});

describe("PlatformCard — syncing", () => {
  it("shows progress + cancel", () => {
    render(
      <PlatformCard
        platform="tiktok"
        state={{ kind: "syncing", progress: { fetched: 412, total: 600 } }}
        onConnect={() => {}}
        onSync={() => {}}
        onReconnect={() => {}}
      />
    );
    expect(screen.getByText(/412.*600/)).toBeTruthy();
  });
});

describe("PlatformCard — error", () => {
  it("shows reason and Retry button", () => {
    const onSync = vi.fn();
    render(
      <PlatformCard
        platform="tiktok"
        state={{ kind: "error", reason: "Rate limit" }}
        onConnect={() => {}}
        onSync={onSync}
        onReconnect={() => {}}
      />
    );
    expect(screen.getByText(/rate limit/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(onSync).toHaveBeenCalledOnce();
  });
});

describe("PlatformCard — expired-auth", () => {
  it("shows Reconnect button", () => {
    const onReconnect = vi.fn();
    render(
      <PlatformCard
        platform="x"
        state={{ kind: "expired-auth" }}
        onConnect={() => {}}
        onSync={() => {}}
        onReconnect={onReconnect}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /reconnect/i }));
    expect(onReconnect).toHaveBeenCalledOnce();
  });
});
