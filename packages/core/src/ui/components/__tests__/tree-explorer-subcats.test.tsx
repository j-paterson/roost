import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { TreeExplorer } from "@/ui/components/tree-explorer";
import type { GroupStore } from "@/ui/lib/group-store";
import type { ItemGroup } from "@/types/item-group";

afterEach(() => cleanup());

/** Minimal GroupStore stub for these tests. We avoid building real cluster
 *  trees and instead drive TreeExplorer via topics + extraGroups paths so
 *  this test stays focused on the subcat render path. */
function makeStore(folders: { id: string; name: string; itemIds: string[] }[]): GroupStore {
  const groups = new Map<string, ItemGroup>();
  for (const f of folders) {
    groups.set(f.id, { id: f.id, name: f.name, itemIds: f.itemIds } as ItemGroup);
  }
  return {
    getTreeRoot: () => null,
    getExtraGroups: () => folders.map(f => groups.get(f.id)!),
    getClusterGroups: () => [],
    getGroup: (id: string) => groups.get(id) ?? null,
  } as unknown as GroupStore;
}

describe("TreeExplorer subcategory rendering", () => {
  it("renders subcategory folder-shaped nodes when subcategoriesFor returns groups", () => {
    const store = makeStore([
      { id: "folder-recipes", name: "Recipes", itemIds: ["a", "b", "c"] },
    ]);
    const subcatsFor = vi.fn((folderId: string) => {
      if (folderId === "folder-recipes") {
        return [
          { name: "Italian", itemIds: ["a", "b"] },
          { name: "French", itemIds: ["c"] },
        ];
      }
      return null;
    });
    render(
      <TreeExplorer
        store={store}
        forceToggle={new Set()}
        sliderSplitIds={new Set()}
        onToggle={() => {}}
        subcategoriesFor={subcatsFor}
      />
    );
    // Both subcategory nodes render as folder-shaped tree-item-self elements.
    const subcatNodes = screen.getAllByText(/Italian|French/);
    expect(subcatNodes.length).toBeGreaterThanOrEqual(2);
    // Subcat nodes carry data-subcat="true".
    const dataSubcats = document.querySelectorAll('[data-subcat="true"]');
    expect(dataSubcats.length).toBe(2);
  });

  it("renders item rows showing {title} ({id}) when titles are provided", () => {
    const store = makeStore([
      { id: "folder-recipes", name: "Recipes", itemIds: ["a"] },
    ]);
    const titles = new Map([["a", "Spaghetti carbonara"]]);
    render(
      <TreeExplorer
        store={store}
        forceToggle={new Set()}
        sliderSplitIds={new Set()}
        onToggle={() => {}}
        subcategoriesFor={(id) => id === "folder-recipes"
          ? [{ name: "Italian", itemIds: ["a"] }]
          : null}
        itemTitles={titles}
      />
    );
    expect(screen.getByText("Spaghetti carbonara (a)")).toBeInTheDocument();
  });

  it("falls back to id alone when a title is missing", () => {
    const store = makeStore([
      { id: "folder-recipes", name: "Recipes", itemIds: ["a"] },
    ]);
    render(
      <TreeExplorer
        store={store}
        forceToggle={new Set()}
        sliderSplitIds={new Set()}
        onToggle={() => {}}
        subcategoriesFor={(id) => id === "folder-recipes"
          ? [{ name: "Italian", itemIds: ["a"] }]
          : null}
      />
    );
    expect(screen.getByText("a")).toBeInTheDocument();
    expect(screen.queryByText(/\(a\)/)).not.toBeInTheDocument();
  });

  it("renders loose items at the parent folder's level when some items have no subcat", () => {
    const store = makeStore([
      { id: "folder-recipes", name: "Recipes", itemIds: ["a", "b", "c"] },
    ]);
    render(
      <TreeExplorer
        store={store}
        forceToggle={new Set()}
        sliderSplitIds={new Set()}
        onToggle={() => {}}
        subcategoriesFor={(id) => id === "folder-recipes"
          ? [{ name: "Italian", itemIds: ["a"] }]
          : null}
      />
    );
    // Loose items area exists.
    const looseArea = document.querySelector('[data-loose-items-for="folder-recipes"]');
    expect(looseArea).not.toBeNull();
    // Loose items "b" and "c" are inside it.
    expect(looseArea!.textContent).toContain("b");
    expect(looseArea!.textContent).toContain("c");
  });

  it("renders nothing extra when subcategoriesFor returns null", () => {
    const store = makeStore([
      { id: "folder-recipes", name: "Recipes", itemIds: ["a"] },
    ]);
    render(
      <TreeExplorer
        store={store}
        forceToggle={new Set()}
        sliderSplitIds={new Set()}
        onToggle={() => {}}
        subcategoriesFor={() => null}
      />
    );
    expect(document.querySelectorAll('[data-subcat="true"]').length).toBe(0);
    expect(document.querySelectorAll('[data-loose-items-for]').length).toBe(0);
  });

  it("renders ✎ icon when folder is in editableFolderIds; calls onEditDescription on click", () => {
    const store = makeStore([
      { id: "folder-recipes", name: "Recipes", itemIds: ["a"] },
    ]);
    const onEdit = vi.fn();
    render(
      <TreeExplorer
        store={store}
        forceToggle={new Set()}
        sliderSplitIds={new Set()}
        onToggle={() => {}}
        editableFolderIds={new Set(["folder-recipes"])}
        onEditDescription={onEdit}
      />
    );
    const editIcon = document.querySelector(".roost-tree-edit-desc")!;
    expect(editIcon).not.toBeNull();
    expect(editIcon.textContent).toBe("✎");
    fireEvent.click(editIcon);
    expect(onEdit).toHaveBeenCalledWith("folder-recipes", "Recipes");
  });

  it("does not render ✎ icon when folder is not in editableFolderIds", () => {
    const store = makeStore([
      { id: "folder-recipes", name: "Recipes", itemIds: ["a"] },
    ]);
    render(
      <TreeExplorer
        store={store}
        forceToggle={new Set()}
        sliderSplitIds={new Set()}
        onToggle={() => {}}
        editableFolderIds={new Set()}
        onEditDescription={() => {}}
      />
    );
    expect(document.querySelector(".roost-tree-edit-desc")).toBeNull();
  });
});
