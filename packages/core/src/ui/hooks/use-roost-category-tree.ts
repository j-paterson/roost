import { useCallback } from "react";
import type { MutableRefObject } from "react";
import { App, Notice, TFile, Menu, Modal } from "obsidian";
import { CATEGORY_FIELD, SUBCATEGORY_FIELD } from "@/config";
import type { RoostFilter, SmartAssignInput } from "@/types/roost";
import { getSyncFiles } from "@/lib/vault-utils";
import { loadCollectionAliases, saveCollectionAliases, makeAliasKey } from "@/lib/collection-aliases";
import { traceEvent } from "@/lib/render-trace";
import { ConfirmScopeModal } from "@/ui/components/confirm-scope-modal";
import { ConfirmDeleteCategoryModal } from "@/ui/components/confirm-delete-category-modal";
import { ConfirmMergeModal } from "@/ui/components/confirm-merge-modal";
import { bulkWriteAssignments } from "@/ui/lib/bulk-write-assignments";
import { moveInList } from "@/ui/lib/move-in-list";
import type { LibraryTreeData } from "@/ui/lib/library-tree";
import { buildResortInput, buildSubcategorizeInput } from "@/ui/lib/smart-assign-inputs";
import type { IRoostPlugin } from "@/types/plugin";
import type { SyncProgress } from "@/ui/components/progress-header";

export interface CategoryTreeSmartAssign {
  mode: string;
  run: (input: SmartAssignInput) => void;
}

export interface RoostCategoryTreeDeps {
  app: App;
  plugin: IRoostPlugin;
  log: (msg: string) => void;
  scanLibrary: () => Promise<void>;
  applyFilter: (filter: RoostFilter) => void;
  libraryTree: LibraryTreeData;
  setSyncProgress: (p: SyncProgress | null | ((prev: SyncProgress | null) => SyncProgress | null)) => void;
  activeFilterRef: MutableRefObject<RoostFilter | null>;
  smartAssign: CategoryTreeSmartAssign;
}

export function useRoostCategoryTree(deps: RoostCategoryTreeDeps) {
  const {
    app,
    plugin,
    log,
    scanLibrary,
    applyFilter,
    libraryTree,
    setSyncProgress,
    activeFilterRef,
    smartAssign,
  } = deps;

  function handleDeleteCategory(category: string, event?: MouseEvent) {
    const files = getSyncFiles(app.vault, plugin.settings.syncFolder);
    const targets = files.filter(file => {
      const fm = app.metadataCache.getFileCache(file)?.frontmatter;
      return fm?.[CATEGORY_FIELD] === category;
    });
    if (targets.length === 0) {
      void runDeleteCategory(category, []);
      return;
    }
    if (!event) {
      new ConfirmDeleteCategoryModal({
        app, kind: "category", categoryName: category, itemCount: targets.length,
        onConfirm: () => { void runDeleteCategory(category, targets); },
      }).open();
      return;
    }
    const menu = new Menu();
    menu.addItem(item => item
      .setTitle(`Delete "${category}" — ${targets.length} item${targets.length !== 1 ? "s" : ""}`)
      .setIcon("trash-2")
      .setSection("danger")
      .onClick(() => { void runDeleteCategory(category, targets); }));
    menu.addItem(item => item.setTitle("Cancel").setIcon("x").onClick(() => { /* no-op */ }));
    menu.showAtMouseEvent(event);
  }

  async function runDeleteCategory(category: string, targets: TFile[]) {
    const itemAssignments = new Map<string, string>();
    const fileByKey = new Map<string, TFile>();
    for (const file of targets) {
      itemAssignments.set(file.path, "");
      fileByKey.set(file.path, file);
    }
    const result = await bulkWriteAssignments({
      itemAssignments,
      fileByKey,
      fileManager: app.fileManager,
      plugin,
      events: app.metadataCache,
      patchFor: () => ({ [CATEGORY_FIELD]: null, [SUBCATEGORY_FIELD]: null }),
      log,
      setProgress: (done, total) =>
        setSyncProgress({ phase: "renaming", count: total, written: done, skipped: 0, resynced: 0 }),
      runUnderGuard: async () => {
        if (plugin.settings.emptySubcategories[category]) {
          delete plugin.settings.emptySubcategories[category];
          await plugin.saveSettings();
        }
        await scanLibrary();
      },
    });
    setSyncProgress(null);
    const errSuffix = result.errors > 0 ? ` (${result.errors} failed)` : "";
    new Notice(`Removed "${category}" from ${result.tagged} item${result.tagged !== 1 ? "s" : ""}${errSuffix}`);
  }

  function handleCreateSubcategory(category: string) {
    const modal = new Modal(app);
    modal.titleEl.setText(`Create subcategory in "${category}"`);
    const input = modal.contentEl.createEl("input", {
      attr: { type: "text", placeholder: "Subcategory name…", style: "width:100%;padding:6px 8px;margin-bottom:8px;" },
    });
    const errorEl = modal.contentEl.createEl("div", { attr: { style: "color:var(--text-error);font-size:var(--font-smallest);min-height:1.2em;" } });
    const btnRow = modal.contentEl.createEl("div", { attr: { style: "display:flex;justify-content:flex-end;gap:6px;" } });
    const cancelBtn = btnRow.createEl("button", { text: "Cancel" });
    const confirmBtn = btnRow.createEl("button", { text: "Create", cls: "mod-cta" });

    const existingSubs = new Set<string>();
    const catEntry = libraryTree.categories.find(c => c.name === category);
    if (catEntry?.subcategories) {
      for (const s of catEntry.subcategories) existingSubs.add(s.name.toLowerCase());
    }

    const doCreate = async () => {
      const name = input.value.trim();
      if (!name) { errorEl.textContent = "Name cannot be empty"; return; }
      if (existingSubs.has(name.toLowerCase())) { errorEl.textContent = "Subcategory already exists"; return; }
      const subs = plugin.settings.emptySubcategories[category] ?? [];
      if (!subs.includes(name)) {
        plugin.settings.emptySubcategories[category] = [...subs, name];
        await plugin.saveSettings();
      }
      modal.close();
      await scanLibrary();
      new Notice(`Created subcategory "${name}" in "${category}"`);
    };

    confirmBtn.addEventListener("click", doCreate);
    cancelBtn.addEventListener("click", () => modal.close());
    input.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") doCreate();
      if (e.key === "Escape") modal.close();
    });
    modal.open();
    input.focus();
  }

  const handleResortCategory = useCallback((category: string) => {
    if (smartAssign.mode !== "sync") return;
    const count = libraryTree.categories.find(c => c.name === category)?.count ?? 0;
    if (count === 0) return;
    new ConfirmScopeModal({
      app,
      kind: "resort",
      categoryName: category,
      itemCount: count,
      onConfirm: () => {
        smartAssign.run(buildResortInput(app, plugin.settings.syncFolder, category));
      },
    }).open();
  }, [app, libraryTree.categories, smartAssign]);

  const handleSortIntoSubcategories = useCallback((category: string) => {
    if (smartAssign.mode !== "sync") return;
    const count = libraryTree.categories.find(c => c.name === category)?.count ?? 0;
    if (count === 0) return;
    new ConfirmScopeModal({
      app,
      kind: "subcategorize",
      categoryName: category,
      itemCount: count,
      onConfirm: () => {
        smartAssign.run(buildSubcategorizeInput(
          app,
          plugin.settings.syncFolder,
          category,
          plugin.settings.emptySubcategories[category] ?? [],
        ));
      },
    }).open();
  }, [app, libraryTree.categories, smartAssign]);

  function handleDeleteSubcategory(category: string, subcategory: string, event?: MouseEvent) {
    const files = getSyncFiles(app.vault, plugin.settings.syncFolder);
    const targets = files.filter(file => {
      const fm = app.metadataCache.getFileCache(file)?.frontmatter;
      return fm?.[CATEGORY_FIELD] === category && fm?.[SUBCATEGORY_FIELD] === subcategory;
    });
    if (targets.length === 0) {
      void runDeleteSubcategory(category, subcategory, []);
      return;
    }
    if (event) {
      const menu = new Menu();
      menu.addItem(item => item
        .setTitle(`Remove subcategory "${subcategory}" — ${targets.length} item${targets.length !== 1 ? "s" : ""} stay in "${category}"`)
        .setIcon("trash-2")
        .setSection("danger")
        .onClick(() => { void runDeleteSubcategory(category, subcategory, targets); }));
      menu.addItem(item => item.setTitle("Cancel").setIcon("x").onClick(() => { /* no-op */ }));
      menu.showAtMouseEvent(event);
      return;
    }
    new ConfirmDeleteCategoryModal({
      app,
      kind: "subcategory",
      categoryName: category,
      subcategoryName: subcategory,
      itemCount: targets.length,
      onConfirm: () => { void runDeleteSubcategory(category, subcategory, targets); },
    }).open();
  }

  async function runDeleteSubcategory(category: string, subcategory: string, targets: TFile[]) {
    const itemAssignments = new Map<string, string>();
    const fileByKey = new Map<string, TFile>();
    for (const file of targets) {
      itemAssignments.set(file.path, "");
      fileByKey.set(file.path, file);
    }
    const result = await bulkWriteAssignments({
      itemAssignments,
      fileByKey,
      fileManager: app.fileManager,
      plugin,
      events: app.metadataCache,
      patchFor: () => ({ [SUBCATEGORY_FIELD]: null }),
      log,
      setProgress: (done, total) =>
        setSyncProgress({ phase: "renaming", count: total, written: done, skipped: 0, resynced: 0 }),
      runUnderGuard: async () => {
        const subs = plugin.settings.emptySubcategories[category];
        if (subs) {
          plugin.settings.emptySubcategories[category] = subs.filter(s => s !== subcategory);
          if (plugin.settings.emptySubcategories[category].length === 0) delete plugin.settings.emptySubcategories[category];
          await plugin.saveSettings();
        }
        await scanLibrary();
      },
    });
    setSyncProgress(null);
    const errSuffix = result.errors > 0 ? ` (${result.errors} failed)` : "";
    new Notice(`Removed subcategory "${subcategory}" — ${result.tagged} item${result.tagged !== 1 ? "s" : ""} stay in "${category}"${errSuffix}`);
  }

  async function handleRenameCategory(oldName: string, newName: string) {
    traceEvent("rename:start", { oldName, newName });
    const files = getSyncFiles(app.vault, plugin.settings.syncFolder);
    const fileByKey = new Map<string, TFile>();
    const itemAssignments = new Map<string, string>();
    for (const file of files) {
      const fm = app.metadataCache.getFileCache(file)?.frontmatter;
      if (fm?.[CATEGORY_FIELD] !== oldName) continue;
      fileByKey.set(file.path, file);
      itemAssignments.set(file.path, newName);
    }
    const result = await bulkWriteAssignments({
      itemAssignments,
      fileByKey,
      fileManager: app.fileManager,
      plugin,
      events: app.metadataCache,
      patchFor: (_, value) => ({ [CATEGORY_FIELD]: value }),
      log,
      setProgress: (done, total) =>
        setSyncProgress({ phase: "renaming", count: total, written: done, skipped: 0, resynced: 0 }),
      runUnderGuard: async () => {
        traceEvent("rename:beforeScanLibrary");
        await scanLibrary();
        traceEvent("rename:afterScanLibrary");
        // Alias capture: record source-collection → newName so future imports
        // from those TikTok collections resolve to the curated name at read
        // time (prevents the renamed category from reappearing on reimport).
        const renamedFiles = getSyncFiles(app.vault, plugin.settings.syncFolder);
        const aliasMap = loadCollectionAliases(app.vault);
        let aliasChanged = false;
        for (const file of renamedFiles) {
          const fm = app.metadataCache.getFileCache(file)?.frontmatter;
          if (fm?.[CATEGORY_FIELD] !== newName) continue;
          const col = fm.collection as string | undefined;
          const plat = (fm.platform as string | undefined) ?? "tiktok";
          if (!col || col === "undefined" || col === "null") continue;
          const key = makeAliasKey(plat, col);
          if (aliasMap[key] !== newName) {
            aliasMap[key] = newName;
            aliasChanged = true;
          }
        }
        if (aliasChanged) saveCollectionAliases(app.vault, aliasMap);
        const activeFilter = activeFilterRef.current;
        if (activeFilter?.category === oldName) {
          traceEvent("rename:filterFollow", { newCategory: newName });
          applyFilter({ ...activeFilter, category: newName });
        }
      },
    });
    if (plugin.settings.emptySubcategories[oldName]) {
      plugin.settings.emptySubcategories[newName] = plugin.settings.emptySubcategories[oldName];
      delete plugin.settings.emptySubcategories[oldName];
      await plugin.saveSettings();
    }
    setSyncProgress(null);
    new Notice(`Renamed "${oldName}" → "${newName}" (${result.tagged} items)`);
    traceEvent("rename:end");
  }

  async function handleRenameSubcategory(category: string, oldName: string, newName: string) {
    const files = getSyncFiles(app.vault, plugin.settings.syncFolder);
    const fileByKey = new Map<string, TFile>();
    const itemAssignments = new Map<string, string>();
    for (const file of files) {
      const fm = app.metadataCache.getFileCache(file)?.frontmatter;
      if (fm?.[CATEGORY_FIELD] !== category || fm?.[SUBCATEGORY_FIELD] !== oldName) continue;
      fileByKey.set(file.path, file);
      itemAssignments.set(file.path, newName);
    }
    const result = await bulkWriteAssignments({
      itemAssignments,
      fileByKey,
      fileManager: app.fileManager,
      plugin,
      events: app.metadataCache,
      patchFor: (_, value) => ({ [SUBCATEGORY_FIELD]: value }),
      log,
      setProgress: (done, total) =>
        setSyncProgress({ phase: "renaming", count: total, written: done, skipped: 0, resynced: 0 }),
      runUnderGuard: async () => {
        await scanLibrary();
        const activeFilter = activeFilterRef.current;
        if (activeFilter?.category === category && activeFilter?.subcategory === oldName) {
          applyFilter({ ...activeFilter, category, subcategory: newName });
        }
      },
    });
    const subs = plugin.settings.emptySubcategories[category];
    if (subs) {
      const idx = subs.indexOf(oldName);
      if (idx !== -1) { subs[idx] = newName; await plugin.saveSettings(); }
    }
    setSyncProgress(null);
    new Notice(`Renamed "${oldName}" → "${newName}" (${result.tagged} items)`);
  }

  function handleRenest(
    source: { category: string; subcategory?: string },
    target: { category: string } | "root",
  ) {
    let title: string;
    let confirmLabel: string;
    let patch: Record<string, string | null>;
    let predicate: (fm: Record<string, unknown> | undefined) => boolean;
    let sourceName: string;
    let targetName: string;
    let newFilter: RoostFilter;

    if (target === "root") {
      if (!source.subcategory) { new Notice("Already at top level"); return; }
      sourceName = `${source.category}/${source.subcategory}`;
      targetName = source.subcategory;
      title = "Promote to top level?";
      confirmLabel = "Promote";
      patch = { [CATEGORY_FIELD]: source.subcategory, [SUBCATEGORY_FIELD]: null };
      predicate = (fm) => fm?.[CATEGORY_FIELD] === source.category && fm?.[SUBCATEGORY_FIELD] === source.subcategory;
      newFilter = { category: source.subcategory };
    } else if (source.subcategory) {
      if (target.category === source.category) { new Notice("Already in this parent"); return; }
      sourceName = `${source.category}/${source.subcategory}`;
      targetName = `${target.category}/${source.subcategory}`;
      title = "Move subcategory?";
      confirmLabel = "Move";
      patch = { [CATEGORY_FIELD]: target.category };
      predicate = (fm) => fm?.[CATEGORY_FIELD] === source.category && fm?.[SUBCATEGORY_FIELD] === source.subcategory;
      newFilter = { category: target.category, subcategory: source.subcategory };
    } else {
      if (target.category === source.category) { new Notice("Cannot drop onto itself"); return; }
      const sourceCat = libraryTree.categories.find(c => c.name === source.category);
      const sourceHasSubs = !!(sourceCat?.subcategories && sourceCat.subcategories.length > 0);
      if (sourceHasSubs) {
        sourceName = source.category;
        targetName = target.category;
        title = `Merge "${source.category}" into "${target.category}"?`;
        confirmLabel = "Merge";
        patch = { [CATEGORY_FIELD]: target.category };
        predicate = (fm) => fm?.[CATEGORY_FIELD] === source.category;
        newFilter = { category: target.category };
      } else {
        sourceName = source.category;
        targetName = `${target.category}/${source.category}`;
        title = "Re-nest as subcategory?";
        confirmLabel = "Re-nest";
        patch = { [CATEGORY_FIELD]: target.category, [SUBCATEGORY_FIELD]: source.category };
        predicate = (fm) => fm?.[CATEGORY_FIELD] === source.category && !fm?.[SUBCATEGORY_FIELD];
        newFilter = { category: target.category, subcategory: source.category };
      }
    }

    const files = getSyncFiles(app.vault, plugin.settings.syncFolder);
    const fileByKey = new Map<string, TFile>();
    const itemAssignments = new Map<string, string>();
    const previewTitles: string[] = [];
    for (const file of files) {
      const fm = app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
      if (!predicate(fm)) continue;
      fileByKey.set(file.path, file);
      itemAssignments.set(file.path, "renest");
      if (previewTitles.length < 5) {
        const title = (fm?.title as string | undefined) || file.basename;
        previewTitles.push(title);
      }
    }
    if (itemAssignments.size === 0) { new Notice("No items to move"); return; }

    new ConfirmMergeModal({
      app,
      sourceName,
      targetName,
      previewTitles,
      itemCount: itemAssignments.size,
      title,
      confirmLabel: `${confirmLabel} ${itemAssignments.size}`,
      onConfirm: async () => {
        const result = await bulkWriteAssignments({
          itemAssignments,
          fileByKey,
          fileManager: app.fileManager,
          plugin,
          events: app.metadataCache,
          patchFor: () => patch,
          log,
          setProgress: (done, total) =>
            setSyncProgress({ phase: "renaming", count: total, written: done, skipped: 0, resynced: 0 }),
          runUnderGuard: async () => {
            await scanLibrary();
            const af = activeFilterRef.current;
            const sourceMatchesActive =
              af?.category === source.category &&
              (source.subcategory ? af?.subcategory === source.subcategory : !af?.subcategory);
            if (sourceMatchesActive) applyFilter(newFilter);
          },
        });
        setSyncProgress(null);
        new Notice(`Moved ${result.tagged} items: ${sourceName} → ${targetName}`);
      },
    }).open();
  }

  async function handleReorder(
    source: { category: string; subcategory?: string },
    target: { category: string; subcategory?: string },
  ) {
    if (source.subcategory) {
      if (!target.subcategory || source.category !== target.category) return;
      if (source.subcategory === target.subcategory) return;
      const parent = source.category;
      const cat = libraryTree.categories.find(c => c.name === parent);
      if (!cat?.subcategories) return;
      const currentNames = cat.subcategories.map(s => s.name);
      const reordered = moveInList(currentNames, source.subcategory, target.subcategory);
      plugin.settings.subcategoryOrder = {
        ...plugin.settings.subcategoryOrder,
        [parent]: reordered,
      };
    } else {
      if (target.subcategory) return;
      if (source.category === target.category) return;
      const currentNames = libraryTree.categories.map(c => c.name);
      const reordered = moveInList(currentNames, source.category, target.category);
      plugin.settings.categoryOrder = reordered;
    }
    await plugin.saveSettings();
    await scanLibrary();
  }

  return {
    onDeleteCategory: handleDeleteCategory,
    onCreateSubcategory: handleCreateSubcategory,
    onDeleteSubcategory: handleDeleteSubcategory,
    onRenameCategory: handleRenameCategory,
    onRenameSubcategory: handleRenameSubcategory,
    onRenest: handleRenest,
    onReorder: handleReorder,
    onResort: handleResortCategory,
    onSortIntoSubcategories: handleSortIntoSubcategories,
  };
}
