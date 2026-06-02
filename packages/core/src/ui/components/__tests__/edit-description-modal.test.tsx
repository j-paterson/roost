import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { EditDescriptionForm } from "@/ui/components/edit-description-modal";

afterEach(() => cleanup());

describe("EditDescriptionForm", () => {
  it("renders pre-filled description and NOT description", () => {
    render(
      <EditDescriptionForm
        categoryName="Italian Pasta"
        initialDescription="Italian pasta dishes"
        initialNotDescription="not pizza"
        onSave={() => {}}
        onCancel={() => {}}
      />
    );
    expect(screen.getByDisplayValue("Italian pasta dishes")).toBeInTheDocument();
    expect(screen.getByDisplayValue("not pizza")).toBeInTheDocument();
  });

  it("calls onSave with edited values", () => {
    const onSave = vi.fn();
    render(
      <EditDescriptionForm
        categoryName="Italian Pasta"
        initialDescription="Italian pasta dishes"
        initialNotDescription="not pizza"
        onSave={onSave}
        onCancel={() => {}}
      />
    );
    const descField = screen.getByDisplayValue("Italian pasta dishes");
    fireEvent.change(descField, { target: { value: "Italian regional pasta recipes" } });
    const saveBtn = screen.getByText("Save");
    fireEvent.click(saveBtn);
    expect(onSave).toHaveBeenCalledWith("Italian regional pasta recipes", "not pizza");
  });

  it("calls onCancel without saving when Cancel is clicked", () => {
    const onSave = vi.fn();
    const onCancel = vi.fn();
    render(
      <EditDescriptionForm
        categoryName="Italian Pasta"
        initialDescription="Italian pasta dishes"
        initialNotDescription=""
        onSave={onSave}
        onCancel={onCancel}
      />
    );
    fireEvent.click(screen.getByText("Cancel"));
    expect(onSave).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalled();
  });

  it("allows clearing the NOT description (saves empty string)", () => {
    const onSave = vi.fn();
    render(
      <EditDescriptionForm
        categoryName="Italian Pasta"
        initialDescription="Italian pasta dishes"
        initialNotDescription="not pizza"
        onSave={onSave}
        onCancel={() => {}}
      />
    );
    const notField = screen.getByDisplayValue("not pizza");
    fireEvent.change(notField, { target: { value: "" } });
    fireEvent.click(screen.getByText("Save"));
    expect(onSave).toHaveBeenCalledWith("Italian pasta dishes", "");
  });
});
