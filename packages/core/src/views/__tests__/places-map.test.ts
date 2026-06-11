import { vi } from "vitest";

const { mockMarker, mockMap, mockBounds, mockTile, mockControl, mockIcon } = vi.hoisted(() => {
  const mockMarker = {
    addTo: vi.fn(function (this: any) { return this; }),
    // Typed parameters so vi.fn().mock.calls infers as [string, fn][] instead
    // of [], unblocking the c[0] / c[1] accesses inside the test handlers.
    on: vi.fn(function (this: any, _evt: string, _handler: (...a: any[]) => any) { return this; }),
    bindTooltip: vi.fn(function (this: any) { return this; }),
    getElement: vi.fn(() => null),
  };
  const mockIcon = { __icon: true };
  const mockBounds = {
    contains: vi.fn((_latlng: [number, number]) => true),
  };
  const mockMap = {
    fitBounds: vi.fn(),
    flyTo: vi.fn(),
    flyToBounds: vi.fn(),
    setView: vi.fn(),
    addLayer: vi.fn(),
    on: vi.fn(),
    getBounds: vi.fn(() => mockBounds),
    getZoom: vi.fn(() => 3),
    invalidateSize: vi.fn(),
    remove: vi.fn(),
  };
  const mockTile = { addTo: vi.fn(() => mockMap) };
  const mockControl = {
    attribution: vi.fn(() => ({ addTo: vi.fn(() => mockMap) })),
    zoom: vi.fn(() => ({ addTo: vi.fn(() => mockMap) })),
  };
  return { mockMarker, mockMap, mockBounds, mockTile, mockControl, mockIcon };
});

vi.mock("leaflet", () => ({
  default: {
    map: vi.fn(() => mockMap),
    tileLayer: vi.fn(() => mockTile),
    marker: vi.fn(() => mockMarker),
    divIcon: vi.fn(() => mockIcon),
    control: mockControl,
    latLngBounds: vi.fn(() => ({ extend: vi.fn(), isValid: () => true })),
  },
}));
vi.mock("leaflet/dist/leaflet.css", () => ({}));

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildMapPins, radiusFor, renderPlacesMap } from "@/views/places-map";
import { makePlaceExtraction } from "@/__tests__/fixtures";
import L from "leaflet";

describe("radiusFor", () => {
  it("returns min 5 at count=0 and max 14 at count=maxCount", () => {
    expect(radiusFor(0, 1)).toBe(5);
    expect(radiusFor(1, 1)).toBe(14);
  });

  it("clamps to 14 max", () => {
    expect(radiusFor(100, 100)).toBe(14);
    expect(radiusFor(200, 100)).toBeLessThanOrEqual(14);
  });

  it("clamps to 5 min", () => {
    expect(radiusFor(0, 100)).toBe(5);
  });

  it("is monotonically non-decreasing in count", () => {
    for (let n = 0; n < 50; n++) {
      expect(radiusFor(n + 1, 50)).toBeGreaterThanOrEqual(radiusFor(n, 50));
    }
  });
});

describe("buildMapPins", () => {
  it("emits one atomic pin per post, even when cities collide", () => {
    const cache = {
      "a": { triage: "place", extraction: makePlaceExtraction({ city: "Rome", country: "Italy" }) },
      "b": { triage: "place", extraction: makePlaceExtraction({ city: "Rome", country: "Italy" }) },
      "c": { triage: "place", extraction: makePlaceExtraction({ city: "Rome", country: "Italy" }) },
    };
    const pins = buildMapPins(cache as any);
    expect(pins).toHaveLength(3);
    const ids = pins.flatMap(p => p.roostIds).sort();
    expect(ids).toEqual(["a", "b", "c"]);
    for (const pin of pins) {
      expect(pin.count).toBe(1);
      expect(pin.roostIds).toHaveLength(1);
    }
  });

  it("jitters same-city pins to distinct coordinates deterministically", () => {
    const cache = {
      "a": { triage: "place", extraction: makePlaceExtraction({ city: "Rome", country: "Italy" }) },
      "b": { triage: "place", extraction: makePlaceExtraction({ city: "Rome", country: "Italy" }) },
    };
    const pins1 = buildMapPins(cache as any);
    const pins2 = buildMapPins(cache as any);
    // Distinct coords within same city
    expect(pins1[0].lat).not.toBe(pins1[1].lat);
    expect(pins1[0].lng).not.toBe(pins1[1].lng);
    // Both pins land near Rome. Tolerance covers GeoNames precision
    // (~0.01° shift from the legacy CITY_COORDS value) plus jitter (±0.015°).
    expect(Math.abs(pins1[0].lat - 41.9)).toBeLessThan(0.05);
    expect(Math.abs(pins1[0].lng - 12.5)).toBeLessThan(0.05);
    // Deterministic across runs
    expect(pins1[0].lat).toBe(pins2[0].lat);
    expect(pins1[0].lng).toBe(pins2[0].lng);
  });

  it("creates separate pins for distinct cities", () => {
    const cache = {
      "a": { triage: "place", extraction: makePlaceExtraction({ city: "Rome", country: "Italy" }) },
      "b": { triage: "place", extraction: makePlaceExtraction({ city: "Paris", country: "France" }) },
    };
    const pins = buildMapPins(cache as any);
    expect(pins.length).toBe(2);
  });

  it("filters entries with unknown country and unknown city", () => {
    const cache = {
      "a": { triage: "place", extraction: makePlaceExtraction({ city: "Atlantis", country: "Narnia" }) },
    };
    expect(buildMapPins(cache as any).length).toBe(0);
  });

  it("uses country centroid coords when city is unknown (label keeps the raw city)", () => {
    // "Obscure Town" is not in CITY_COORDS; "Italy" is in COUNTRY_COORDS.
    // geocode returns Italy's centroid (42.5, 12.6); the label path formats
    // "<city>, <country>" verbatim because city !== country.
    const cache = {
      "a": { triage: "place", extraction: makePlaceExtraction({ city: "Obscure Town", country: "Italy" }) },
    };
    const pins = buildMapPins(cache as any);
    expect(pins.length).toBe(1);
    expect(pins[0].label).toBe("Obscure Town, Italy");
    expect(pins[0].lat).toBeCloseTo(42.5, 1);
    expect(pins[0].lng).toBeCloseTo(12.6, 1);
  });

  it("skips entries whose triage !== 'place'", () => {
    const cache = {
      "a": { triage: "recipe", extraction: makePlaceExtraction({ city: "Rome", country: "Italy" }) },
    };
    expect(buildMapPins(cache as any).length).toBe(0);
  });
});

// Obsidian extends HTMLElement with createDiv/empty; jsdom does not.
// Factory installs just enough of that surface for renderPlacesMap.
function makeContainer(): HTMLElement {
  const c = document.createElement("div") as any;
  c.empty = function () { while (this.firstChild) this.removeChild(this.firstChild); };
  c.createDiv = function (opts: any) {
    const d = document.createElement("div");
    if (opts?.cls) d.className = opts.cls;
    if (opts?.text) d.textContent = opts.text;
    this.appendChild(d);
    return d;
  };
  return c as HTMLElement;
}

describe("renderPlacesMap — Leaflet wiring", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(L.map).mockClear();
    vi.mocked(L.tileLayer).mockClear();
    vi.mocked(L.marker).mockClear();
    vi.mocked(L.divIcon).mockClear();
    mockMarker.addTo.mockClear();
    mockMarker.on.mockClear();
    mockMap.on.mockClear();
    mockMap.flyTo.mockClear();
    mockMap.getZoom.mockReset();
    mockMap.getZoom.mockReturnValue(3);
    mockBounds.contains.mockReset();
    mockBounds.contains.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates one map, one tile layer, one marker per pin", () => {
    const pins = [
      { lat: 41.9, lng: 12.5, label: "Rome, Italy", count: 1, roostIds: ["a"] },
      { lat: 48.9, lng: 2.3, label: "Paris, France", count: 2, roostIds: ["b", "c"] },
    ];
    renderPlacesMap(makeContainer(), pins);
    expect(vi.mocked(L.map)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(L.tileLayer)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(L.marker)).toHaveBeenCalledTimes(2);
  });

  it("disables marker click bubbling (otherwise bg-click deselect eats the flyTo)", () => {
    const pins = [{ lat: 41.9, lng: 12.5, label: "Rome", count: 1, roostIds: ["a"] }];
    renderPlacesMap(makeContainer(), pins);
    const opts = vi.mocked(L.marker).mock.calls[0]?.[1] as any;
    expect(opts?.bubblingMouseEvents).toBe(false);
  });

  it("renders a divIcon with cover image <img> when getCoverUrl resolves", () => {
    const pins = [{ lat: 41.9, lng: 12.5, label: "Rome", count: 1, roostIds: ["a"] }];
    const getCoverUrl = (id: string) => id === "a" ? "app://x/a.jpg" : null;
    renderPlacesMap(makeContainer(), pins, undefined, getCoverUrl);
    const divIconArgs = vi.mocked(L.divIcon).mock.calls[0]?.[0] as any;
    expect(divIconArgs?.html).toContain("app://x/a.jpg");
    expect(divIconArgs?.html).toContain("roost-map-pin");
  });

  it("uses the empty-pin variant when no cover URL is available", () => {
    const pins = [{ lat: 41.9, lng: 12.5, label: "Rome", count: 1, roostIds: ["a"] }];
    renderPlacesMap(makeContainer(), pins);
    const divIconArgs = vi.mocked(L.divIcon).mock.calls[0]?.[0] as any;
    expect(divIconArgs?.html).toContain("roost-map-pin-empty");
    expect(divIconArgs?.html).not.toContain("<img");
  });

  it("pin click clamps zoom to MIN_FOCUS_ZOOM when the user is zoomed out", () => {
    mockMap.getZoom.mockReturnValue(3);
    const pins = [{ lat: 41.9, lng: 12.5, label: "Rome", count: 1, roostIds: ["a"] }];
    renderPlacesMap(makeContainer(), pins);
    const handler = mockMarker.on.mock.calls.find(c => c[0] === "click")![1];
    handler();
    expect(mockMap.flyTo).toHaveBeenCalledWith([41.9, 12.5], 10, expect.any(Object));
  });

  it("pin click preserves the user's zoom when they're already zoomed in past MIN_FOCUS_ZOOM", () => {
    mockMap.getZoom.mockReturnValue(12);
    const pins = [{ lat: 41.9, lng: 12.5, label: "Rome", count: 1, roostIds: ["a"] }];
    renderPlacesMap(makeContainer(), pins);
    const handler = mockMarker.on.mock.calls.find(c => c[0] === "click")![1];
    handler();
    // Zoom stays at 12 — clicking a pin while zoomed-in must not zoom OUT.
    expect(mockMap.flyTo).toHaveBeenCalledWith([41.9, 12.5], 12, expect.any(Object));
  });

  it("marker click triggers flyTo but does not directly invoke onPinClick", () => {
    const onPinClick = vi.fn();
    const pins = [{ lat: 41.9, lng: 12.5, label: "Rome", count: 1, roostIds: ["a"] }];

    renderPlacesMap(makeContainer(), pins, onPinClick);

    const clickCall = mockMarker.on.mock.calls.find(c => c[0] === "click");
    expect(clickCall).toBeTruthy();
    const handler = clickCall![1];
    handler();
    // Viewport-driven: the click flies to the pin; moveend then fires the filter.
    expect(mockMap.flyTo).toHaveBeenCalled();
    expect(onPinClick).not.toHaveBeenCalled();
  });

  it("moveend (debounced) calls onPinClick with visible roostIds", () => {
    const onPinClick = vi.fn();
    const pins = [
      { lat: 41.9, lng: 12.5, label: "Rome", count: 1, roostIds: ["a"] },
      { lat: 48.9, lng: 2.3, label: "Paris", count: 1, roostIds: ["b"] },
      { lat: 35.7, lng: 139.7, label: "Tokyo", count: 1, roostIds: ["c"] },
    ];
    // Only Rome in viewport
    mockBounds.contains.mockImplementation(([lat, lng]: [number, number]) =>
      lat > 40 && lat < 45 && lng > 10 && lng < 15
    );

    renderPlacesMap(makeContainer(), pins, onPinClick);

    const moveendCall = mockMap.on.mock.calls.find(c => c[0] === "moveend");
    expect(moveendCall).toBeTruthy();
    const handler = moveendCall![1];
    handler();
    // Debounced — not called synchronously
    expect(onPinClick).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(onPinClick).toHaveBeenCalledTimes(1);
    expect(onPinClick).toHaveBeenCalledWith(["a"], undefined);
  });

  it("moveend with no pins in viewport emits an empty array", () => {
    const onPinClick = vi.fn();
    const pins = [{ lat: 41.9, lng: 12.5, label: "Rome", count: 1, roostIds: ["a"] }];
    mockBounds.contains.mockReturnValue(false);

    renderPlacesMap(makeContainer(), pins, onPinClick);
    const moveendCall = mockMap.on.mock.calls.find(c => c[0] === "moveend");
    moveendCall![1]();
    vi.advanceTimersByTime(200);
    expect(onPinClick).toHaveBeenCalledWith([], undefined);
  });

  it("rapid moveend events debounce into a single onPinClick call", () => {
    const onPinClick = vi.fn();
    const pins = [{ lat: 41.9, lng: 12.5, label: "Rome", count: 1, roostIds: ["a"] }];

    renderPlacesMap(makeContainer(), pins, onPinClick);
    const handler = mockMap.on.mock.calls.find(c => c[0] === "moveend")![1];
    handler(); handler(); handler();
    vi.advanceTimersByTime(200);
    expect(onPinClick).toHaveBeenCalledTimes(1);
  });

  it("marker click passes focusRoostId through moveend to onPinClick (for expand-at-top)", () => {
    const onPinClick = vi.fn();
    const pins = [{ lat: 41.9, lng: 12.5, label: "Rome", count: 1, roostIds: ["a"] }];

    renderPlacesMap(makeContainer(), pins, onPinClick);
    const markerClick = mockMarker.on.mock.calls.find(c => c[0] === "click")![1];
    markerClick();
    // Marker click sets pendingFocusId but does NOT invoke onPinClick directly.
    expect(onPinClick).not.toHaveBeenCalled();
    // flyTo triggers moveend in real Leaflet; simulate it here.
    const moveendHandler = mockMap.on.mock.calls.find(c => c[0] === "moveend")![1];
    moveendHandler();
    vi.advanceTimersByTime(200);
    expect(onPinClick).toHaveBeenCalledWith(["a"], "a");
  });
});
