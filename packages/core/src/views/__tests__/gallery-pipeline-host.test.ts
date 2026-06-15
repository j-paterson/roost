/**
 * Host-level contract: PipelineGalleryHost owns the substitute container.
 *
 * Key invariant: after dispatch-away from a substitute category, containerEl
 * contains NO view DOM — even if the view's dispose fails to clean up
 * (defense-in-depth: the host removes the wrapper unconditionally).
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";

// Mock the guards so dispatch() always sees the pipeline as active.
vi.mock("@/lib/roost-plugin", () => ({
  getRoostPlugin: () => ({ __mock: true }),
}));
vi.mock("@/lib/pipeline-gate-plugin", () => ({
  isCategoryPipelineActive: () => true,
}));

import { PipelineGalleryHost } from "@/views/gallery-pipeline-host";
import {
  registerPipelineGalleryView,
  _testOnlyResetRegistry,
  type GalleryRenderContext,
  type PipelineGalleryHandle,
} from "@/views/pipeline-views/registry";

// Polyfill Obsidian DOM augmentations (happy-dom does not ship these).
beforeAll(() => {
  const proto = HTMLElement.prototype as any;
  if (!proto.createDiv) {
    proto.createDiv = function (opts?: { cls?: string; text?: string }) {
      const d = document.createElement("div");
      if (opts?.cls) d.className = opts.cls;
      if (opts?.text) d.textContent = opts.text;
      this.appendChild(d);
      return d;
    };
    proto.createEl = function (tag: string, opts?: { cls?: string; text?: string }) {
      const el = document.createElement(tag) as any;
      if (opts?.cls) el.className = opts.cls;
      if (opts?.text) el.textContent = opts.text;
      this.appendChild(el);
      return el;
    };
    proto.createSpan = function (opts?: { cls?: string; text?: string }) {
      const s = document.createElement("span");
      if (opts?.cls) s.className = opts.cls;
      if (opts?.text) s.textContent = opts.text;
      this.appendChild(s);
      return s;
    };
    proto.setText = function (text: string) { this.textContent = text; };
    proto.setAttr = function (name: string, value: string) { this.setAttribute(name, value); };
    proto.addClass = function (cls: string) { this.classList.add(cls); };
    proto.removeClass = function (cls: string) { this.classList.remove(cls); };
    proto.empty = function () { while (this.firstChild) this.removeChild(this.firstChild); };
  }
});

const FAKE_SUB_CATEGORY = "__host_test_substitute__";

function makeDeps(containerEl: HTMLElement, category: string): ConstructorParameters<typeof PipelineGalleryHost>[0] {
  return {
    app: {} as any,
    containerEl,
    scrollEl: document.createElement("div"),
    getFeedSplitHostEl: () => null,
    getFilter: () => ({ category }) as any,
    getEntries: () => [],
    getFilteredIndices: () => null,
    setFilter: () => {},
    rerender: () => {},
    resolveImageUrl: () => null,
    resolveVideoUrl: () => null,
    pinAndFocus: () => {},
    renderExpandedCard: (() => () => {}) as any,
  };
}

function makeMisbehavingSubstituteView() {
  return {
    mode: "substitute" as const,
    render(container: HTMLElement, _ctx: GalleryRenderContext): PipelineGalleryHandle {
      const sentinel = document.createElement("div");
      sentinel.className = "fake-substitute-sentinel";
      container.appendChild(sentinel);
      return { dispose: () => { /* deliberately leaks */ } };
    },
  };
}

function makeGoodSubstituteView() {
  return {
    mode: "substitute" as const,
    render(container: HTMLElement, _ctx: GalleryRenderContext): PipelineGalleryHandle {
      const el = document.createElement("div");
      el.className = "good-substitute-content";
      container.appendChild(el);
      return { dispose: () => { el.remove(); } };
    },
  };
}

describe("PipelineGalleryHost — substitute container ownership", () => {
  beforeEach(() => { _testOnlyResetRegistry(); });
  afterEach(() => { _testOnlyResetRegistry(); });

  it("dispatch() creates a host-owned substituteContainer inside containerEl", () => {
    const containerEl = document.createElement("div");
    const host = new PipelineGalleryHost(makeDeps(containerEl, FAKE_SUB_CATEGORY));
    registerPipelineGalleryView(FAKE_SUB_CATEGORY, makeMisbehavingSubstituteView());

    const isSubstitute = host.dispatch();

    expect(isSubstitute).toBe(true);
    expect(containerEl.children.length).toBe(1);
    const wrapper = containerEl.children[0] as HTMLElement;
    expect(wrapper.classList.contains("roost-media-list-host")).toBe(true);
    expect(wrapper.querySelector(".fake-substitute-sentinel")).toBeTruthy();
  });

  it("dispose() removes the substituteContainer even when the view's dispose is buggy", () => {
    const containerEl = document.createElement("div");
    const host = new PipelineGalleryHost(makeDeps(containerEl, FAKE_SUB_CATEGORY));
    registerPipelineGalleryView(FAKE_SUB_CATEGORY, makeMisbehavingSubstituteView());

    host.dispatch();
    expect(containerEl.querySelector(".fake-substitute-sentinel")).toBeTruthy();

    host.dispose();

    expect(containerEl.children.length).toBe(0);
    expect(containerEl.querySelector(".fake-substitute-sentinel")).toBeNull();
  });

  it("dispatching a different category tears down the previous substituteContainer", () => {
    const containerEl = document.createElement("div");
    const CATEGORY_A = "__host_test_cat_a__";
    const CATEGORY_B = "__host_test_cat_b__";

    let categoryForFilter = CATEGORY_A;
    const deps = {
      ...makeDeps(containerEl, CATEGORY_A),
      getFilter: () => ({ category: categoryForFilter }) as any,
    };
    const host = new PipelineGalleryHost(deps);
    registerPipelineGalleryView(CATEGORY_A, makeMisbehavingSubstituteView());
    registerPipelineGalleryView(CATEGORY_B, makeGoodSubstituteView());

    host.dispatch();
    expect(containerEl.querySelector(".fake-substitute-sentinel")).toBeTruthy();

    categoryForFilter = CATEGORY_B;
    host.dispatch();

    expect(containerEl.querySelector(".fake-substitute-sentinel")).toBeNull();
    expect(containerEl.querySelector(".good-substitute-content")).toBeTruthy();
    expect(containerEl.children.length).toBe(1);
  });

  it("sameCategory re-dispatch RE-RENDERS (data refresh) without accumulating wrappers", () => {
    // The grid driver calls containerEl.empty() + dispatch() on every
    // onDataUpdated while a substitute category is active, so same-category
    // re-dispatch MUST re-render to repopulate — but must not leak wrappers.
    const containerEl = document.createElement("div");
    const host = new PipelineGalleryHost(makeDeps(containerEl, FAKE_SUB_CATEGORY));

    let renderCount = 0;
    registerPipelineGalleryView(FAKE_SUB_CATEGORY, {
      mode: "substitute" as const,
      render(container: HTMLElement, _ctx: GalleryRenderContext): PipelineGalleryHandle {
        renderCount++;
        const el = document.createElement("div");
        el.className = "good-substitute-content";
        container.appendChild(el);
        return { dispose: () => { el.remove(); } };
      },
    });

    host.dispatch();
    host.dispatch();

    expect(renderCount).toBe(2);                  // re-rendered, not skipped
    expect(containerEl.children.length).toBe(1);  // exactly one wrapper, no accumulation
    expect(containerEl.querySelectorAll(".good-substitute-content").length).toBe(1);
  });

  it("simulated onDataUpdated (empty + re-dispatch) keeps the substitute table present", () => {
    // Reproduces the production teardown/rebuild cycle: the driver empties the
    // container, then dispatches. The host must re-render so the table doesn't
    // vanish on data updates.
    const containerEl = document.createElement("div");
    const host = new PipelineGalleryHost(makeDeps(containerEl, FAKE_SUB_CATEGORY));
    registerPipelineGalleryView(FAKE_SUB_CATEGORY, makeGoodSubstituteView());

    host.dispatch();
    expect(containerEl.querySelector(".good-substitute-content")).toBeTruthy();

    // Grid driver wipes the container on the next onDataUpdated...
    containerEl.replaceChildren();
    // ...then re-dispatches (same category).
    host.dispatch();

    expect(containerEl.querySelector(".good-substitute-content")).toBeTruthy(); // table back
    expect(containerEl.children.length).toBe(1);
  });
});
