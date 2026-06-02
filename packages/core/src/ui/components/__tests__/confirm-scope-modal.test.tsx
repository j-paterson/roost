import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, screen, cleanup } from "@testing-library/react";

afterEach(() => cleanup());

import { ConfirmScopeOverlay } from "../confirm-scope-modal";

describe("ConfirmScopeOverlay", () => {
  it("renders resort title, item count, and calls onConfirm", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmScopeOverlay
        kind="resort"
        categoryName="Animals"
        itemCount={42}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    expect(screen.getByText(/Resort "Animals"/)).toBeTruthy();
    expect(screen.getByText(/42 items/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Resort$/ }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("renders subcategorize title and calls onCancel", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmScopeOverlay
        kind="subcategorize"
        categoryName="Animals"
        itemCount={7}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    expect(screen.getByText(/Sort "Animals" into subcategories/)).toBeTruthy();
    expect(screen.getByText(/7 items/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Cancel/ }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("pluralizes '1 item' correctly", () => {
    render(
      <ConfirmScopeOverlay
        kind="resort"
        categoryName="Animals"
        itemCount={1}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByText(/1 item\b/)).toBeTruthy();
  });
});
