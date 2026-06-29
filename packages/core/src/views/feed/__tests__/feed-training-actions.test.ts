import { describe, it, expect, vi } from "vitest";
import { buildTrainingBar } from "@/views/feed/feed-renderers";

describe("buildTrainingBar", () => {
  it("shows the guessed category and wires the four actions", () => {
    const onConfirm = vi.fn(), onReject = vi.fn(), onRecategorize = vi.fn(), onSkip = vi.fn();
    const bar = buildTrainingBar(document, "Tech", { onConfirm, onReject, onRecategorize, onSkip });
    expect(bar.textContent).toContain("Tech");
    bar.querySelector<HTMLElement>('[data-action="confirm"]')!.click();
    bar.querySelector<HTMLElement>('[data-action="reject"]')!.click();
    bar.querySelector<HTMLElement>('[data-action="recategorize"]')!.click();
    bar.querySelector<HTMLElement>('[data-action="skip"]')!.click();
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onReject).toHaveBeenCalledOnce();
    expect(onRecategorize).toHaveBeenCalledOnce();
    expect(onSkip).toHaveBeenCalledOnce();
  });
});
