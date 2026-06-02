import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { LibraryTree } from "@/ui/components/library-tree";
import type { RoostFilter } from "@/types/roost";

// Capture the last-constructed Menu for assertions
type MenuItemConfig = { title: string; disabled?: boolean; onClick?: () => void };
const menuItemsByInstance: MenuItemConfig[][] = [];

// Note: vi.importActual("obsidian") resolves to src/__mocks__/obsidian.ts via the vitest alias, not the real package.
vi.mock("obsidian", async () => {
  const actual = await vi.importActual<typeof import("obsidian")>("obsidian");
  class CapturingMenu {
    items: MenuItemConfig[] = [];
    constructor() { menuItemsByInstance.push(this.items); }
    addItem(cb: (item: {
      setTitle: (t: string) => typeof item;
      setIcon: (n: string) => typeof item;
      setDisabled: (d: boolean) => typeof item;
      onClick: (fn: () => void) => typeof item;
    }) => void) {
      const config: MenuItemConfig = { title: "" };
      const item = {
        setTitle: (t: string) => { config.title = t; return item; },
        setIcon: () => item,
        setDisabled: (d: boolean) => { config.disabled = d; return item; },
        onClick: (fn: () => void) => { config.onClick = fn; return item; },
      };
      cb(item);
      this.items.push(config);
      return this;
    }
    addSeparator() { return this; }
    showAtMouseEvent() { return this; }
  }
  return { ...actual, Menu: CapturingMenu };
});

afterEach(() => cleanup());

function renderTree(pipelineCategories?: Set<string>) {
  const categories = [
    { name: "Recipes", count: 5 },
    { name: "Travel", count: 3 },
  ];
  const props: any = {
    categories,
    pipelineCategories,
    total: 8,
    unsorted: 0,
    platforms: [],
    activeFilter: { category: null } as any,
    activePlatform: null,
    syncingPlatform: null,
    syncing: false,
    importing: false,
    onFilter: () => {},
    onShowPlatform: () => {},
    onHidePlatform: () => {},
    onSync: () => {},
    onImportEagle: () => {},
  };
  return render(<LibraryTree {...props} />);
}

const baseProps = {
  total: 100,
  unsorted: 0,
  platforms: [],
  activeFilter: null as RoostFilter,
  activePlatform: null,
  syncingPlatform: null,
  syncing: false,
  importing: false,
  onFilter: () => {},
  onShowPlatform: () => {},
  onHidePlatform: () => {},
  onSync: () => {},
  onImportEagle: () => {},
};

function findItem(items: MenuItemConfig[], re: RegExp) {
  return items.find(i => re.test(i.title));
}

describe("<LibraryTree> pipeline run control", () => {
  const pipelineProps = {
    ...baseProps,
    categories: [{ name: "Recipes", count: 5 }],
    pipelineCategories: new Set(["recipes"]),
    onRunPipeline: vi.fn(),
  };

  it("shows Run pipeline when category is runnable", () => {
    render(
      <LibraryTree
        {...pipelineProps}
        isPipelineRunnable={() => true}
      />,
    );
    expect(screen.getByRole("button", { name: "Run pipeline" })).toBeTruthy();
  });

  it("hides Run pipeline when category is not runnable", () => {
    render(
      <LibraryTree
        {...pipelineProps}
        isPipelineRunnable={() => false}
      />,
    );
    expect(screen.queryByRole("button", { name: "Run pipeline" })).toBeNull();
  });
});

describe("<LibraryTree> pipeline-category highlight", () => {
  it("adds roost-tree-pipeline class when category matches", () => {
    const { container } = renderTree(new Set(["recipes"]));
    const row = container.querySelector("[data-category='Recipes']") as HTMLElement | null;
    const anchor = row ?? screen.getByText("Recipes").closest(".tree-item-self") as HTMLElement;
    expect(anchor.classList.contains("roost-tree-pipeline")).toBe(true);
  });

  it("does not add the class without the prop", () => {
    renderTree(undefined);
    const anchor = screen.getByText("Recipes").closest(".tree-item-self") as HTMLElement;
    expect(anchor.classList.contains("roost-tree-pipeline")).toBe(false);
  });

  it("match lowercases the category name (mixed-case in set still matches)", () => {
    renderTree(new Set(["RECIPES"]));
    const anchor = screen.getByText("Recipes").closest(".tree-item-self") as HTMLElement;
    // Set contains "RECIPES"; category is "Recipes". Highlight uses cat.name.toLowerCase(),
    // so it looks for "recipes" — which the Set does NOT contain. Should NOT highlight.
    expect(anchor.classList.contains("roost-tree-pipeline")).toBe(false);
  });
});

describe("LibraryTree context menu", () => {
  beforeEach(() => { menuItemsByInstance.length = 0; });

  it("adds Resort and Sort items on top-level categories", () => {
    const onResort = vi.fn();
    const onSort = vi.fn();
    const { getByText } = render(
      <LibraryTree
        {...baseProps}
        categories={[{ name: "Animals", count: 42 }]}
        onResort={onResort}
        onSortIntoSubcategories={onSort}
      />,
    );
    fireEvent.contextMenu(getByText("Animals"));
    const items = menuItemsByInstance.at(-1)!;
    const resortItem = findItem(items, /Resort with Smart Assign/);
    const sortItem = findItem(items, /Sort into subcategories/);
    expect(resortItem).toBeDefined();
    expect(sortItem).toBeDefined();
    expect(resortItem?.disabled).toBeFalsy();
    expect(sortItem?.disabled).toBeFalsy();
    resortItem!.onClick!();
    expect(onResort).toHaveBeenCalledWith("Animals");
    sortItem!.onClick!();
    expect(onSort).toHaveBeenCalledWith("Animals");
  });

  it("disables menu items when smartAssignBusy is true", () => {
    const { getByText } = render(
      <LibraryTree
        {...baseProps}
        categories={[{ name: "Animals", count: 42 }]}
        smartAssignBusy
        onResort={() => {}}
        onSortIntoSubcategories={() => {}}
      />,
    );
    fireEvent.contextMenu(getByText("Animals"));
    const items = menuItemsByInstance.at(-1)!;
    expect(findItem(items, /Resort with Smart Assign/)?.disabled).toBe(true);
    expect(findItem(items, /Sort into subcategories/)?.disabled).toBe(true);
  });

  it("disables menu items when category has 0 items", () => {
    const { getByText } = render(
      <LibraryTree
        {...baseProps}
        categories={[{ name: "Empty", count: 0 }]}
        onResort={() => {}}
        onSortIntoSubcategories={() => {}}
      />,
    );
    fireEvent.contextMenu(getByText("Empty"));
    const items = menuItemsByInstance.at(-1)!;
    expect(findItem(items, /Resort with Smart Assign/)?.disabled).toBe(true);
    expect(findItem(items, /Sort into subcategories/)?.disabled).toBe(true);
  });

  it("does not add Resort/Sort items on subcategory rows", () => {
    const { getByText } = render(
      <LibraryTree
        {...baseProps}
        categories={[{
          name: "Animals",
          count: 5,
          subcategories: [{ name: "Dogs", count: 2 }],
        }]}
        onResort={() => {}}
        onSortIntoSubcategories={() => {}}
      />,
    );
    fireEvent.contextMenu(getByText("Dogs"));
    const items = menuItemsByInstance.at(-1)!;
    expect(findItem(items, /Resort with Smart Assign/)).toBeUndefined();
    expect(findItem(items, /Sort into subcategories/)).toBeUndefined();
  });
});

describe("LibraryTree menu callback wiring", () => {
  beforeEach(() => { menuItemsByInstance.length = 0; });

  it("Resort click fires onResort with correct category, not onSortIntoSubcategories", () => {
    const onResort = vi.fn();
    const onSort = vi.fn();
    const { getByText } = render(
      <LibraryTree
        {...baseProps}
        categories={[{ name: "Animals", count: 42 }, { name: "Food", count: 10 }]}
        onResort={onResort}
        onSortIntoSubcategories={onSort}
      />,
    );
    fireEvent.contextMenu(getByText("Animals"));
    const items = menuItemsByInstance.at(-1)!;
    findItem(items, /Resort with Smart Assign/)!.onClick!();
    expect(onResort).toHaveBeenCalledTimes(1);
    expect(onResort).toHaveBeenCalledWith("Animals");
    expect(onSort).not.toHaveBeenCalled();
  });

  it("Sort click fires onSortIntoSubcategories, not onResort", () => {
    const onResort = vi.fn();
    const onSort = vi.fn();
    const { getByText } = render(
      <LibraryTree
        {...baseProps}
        categories={[{ name: "Animals", count: 42 }]}
        onResort={onResort}
        onSortIntoSubcategories={onSort}
      />,
    );
    fireEvent.contextMenu(getByText("Animals"));
    const items = menuItemsByInstance.at(-1)!;
    findItem(items, /Sort into subcategories/)!.onClick!();
    expect(onSort).toHaveBeenCalledTimes(1);
    expect(onSort).toHaveBeenCalledWith("Animals");
    expect(onResort).not.toHaveBeenCalled();
  });
});
