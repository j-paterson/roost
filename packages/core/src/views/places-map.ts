/**
 * Interactive world map for the Places folder view.
 *
 * Uses Leaflet with OpenStreetMap tiles to plot pins from city/country names.
 * Falls back to country centroid when city isn't in the lookup.
 */
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { PipelineCacheEntry, PlaceExtraction } from "@/types/roost";
import { resolveByCityName } from "@/lib/geonames";

// ── Coordinate lookups ──

const COUNTRY_COORDS: Record<string, [number, number]> = {
  "united states": [39.8, -98.6], "usa": [39.8, -98.6], "us": [39.8, -98.6],
  "canada": [56.1, -106.3], "mexico": [23.6, -102.6],
  "italy": [42.5, 12.6], "france": [46.6, 2.2], "spain": [40.5, -3.7],
  "portugal": [39.4, -8.2], "germany": [51.2, 10.5], "switzerland": [46.8, 8.2],
  "united kingdom": [54.0, -2.0], "scotland": [56.5, -4.0],
  "netherlands": [52.1, 5.3], "belgium": [50.5, 4.5], "austria": [47.5, 13.4],
  "norway": [60.5, 8.5], "sweden": [62.0, 15.0], "denmark": [56.3, 9.5],
  "iceland": [64.9, -19.0], "romania": [45.9, 24.9], "ukraine": [48.4, 31.2],
  "greece": [39.1, 21.8], "turkey": [39.9, 32.9],
  "japan": [36.2, 138.3], "china": [35.9, 104.2], "hong kong": [22.3, 114.2],
  "india": [20.6, 79.0], "thailand": [15.9, 101.0], "vietnam": [14.1, 108.3],
  "indonesia": [0.8, 113.9], "philippines": [12.9, 121.8], "singapore": [1.4, 103.8],
  "nepal": [28.4, 84.1], "laos": [19.9, 102.5], "bhutan": [27.5, 90.4],
  "iran": [32.4, 53.7], "uae": [24.0, 54.0], "united arab emirates": [24.0, 54.0],
  "australia": [-25.3, 133.8], "south africa": [-30.6, 22.9],
  "morocco": [31.8, -7.1], "mauritania": [21.0, -10.9],
  "brazil": [-14.2, -51.9], "brasil": [-14.2, -51.9],
  "colombia": [4.6, -74.1], "peru": [-9.2, -75.0], "chile": [-35.7, -71.5],
  "argentina": [-38.4, -63.6], "ecuador": [-1.8, -78.2], "bolivia": [-16.3, -63.6],
  "guatemala": [15.8, -90.2], "jamaica": [18.1, -77.3],
  "puerto rico": [18.2, -66.6], "st. lucia": [13.9, -61.0],
  "cabo verde": [16.0, -24.0], "kyrgyzstan": [41.2, 74.8],
  "yemen": [15.6, 48.5],
  "california": [36.8, -119.4],
  "argentina/chile": [-38.4, -68.0], "vietnam/laos": [17.0, 105.0],
};

const CITY_COORDS: Record<string, [number, number]> = {
  "new york": [40.7, -74.0], "los angeles": [34.1, -118.2],
  "austin": [30.3, -97.7], "austin city": [30.3, -97.7],
  "san francisco": [37.8, -122.4], "chicago": [41.9, -87.6],
  "seattle": [47.6, -122.3], "miami": [25.8, -80.2],
  "portland": [45.5, -122.7], "denver": [39.7, -105.0],
  "nashville": [36.2, -86.8], "forks": [47.9, -124.4],
  "driftwood": [30.1, -98.0],
  "paris": [48.9, 2.3], "london": [51.5, -0.1], "barcelona": [41.4, 2.2],
  "rome": [41.9, 12.5], "como": [45.8, 9.1], "belluno": [46.1, 12.2],
  "airolo": [46.5, 8.6],
  "mexico city": [19.4, -99.1], "medellín": [6.2, -75.6], "medellin": [6.2, -75.6],
  "tokyo": [35.7, 139.7], "kyoto": [35.0, 135.8], "osaka": [34.7, 135.5],
  "bangkok": [13.8, 100.5], "singapore": [1.4, 103.8],
  "banff": [51.2, -115.6], "improvement district  9 banff": [51.2, -115.6],
  "sydney": [33.9, 151.2], "lisbon": [38.7, -9.1],
};

interface MapPin {
  lat: number;
  lng: number;
  label: string;
  /** Preserved for compatibility with radiusFor; always 1 for atomic pins. */
  count: number;
  roostIds: string[];
}

/** Rough country-name → ISO2 lookup for GeoNames name-based geocoding.
 *  Only needed when an extraction has no lat/lng (pre-GeoNames cache entries)
 *  and we want to try the name-based fallback. */
const COUNTRY_NAME_TO_ISO: Record<string, string> = {
  "united states": "US", "usa": "US", "us": "US",
  "united kingdom": "GB", "england": "GB", "scotland": "GB", "wales": "GB",
  "italy": "IT", "france": "FR", "spain": "ES", "portugal": "PT",
  "germany": "DE", "switzerland": "CH", "netherlands": "NL", "belgium": "BE",
  "austria": "AT", "greece": "GR", "turkey": "TR", "ireland": "IE",
  "norway": "NO", "sweden": "SE", "denmark": "DK", "iceland": "IS",
  "poland": "PL", "czech republic": "CZ", "hungary": "HU", "romania": "RO",
  "ukraine": "UA", "russia": "RU", "croatia": "HR", "slovenia": "SI",
  "japan": "JP", "china": "CN", "hong kong": "HK", "taiwan": "TW",
  "south korea": "KR", "korea": "KR", "india": "IN",
  "thailand": "TH", "vietnam": "VN", "indonesia": "ID", "philippines": "PH",
  "singapore": "SG", "malaysia": "MY", "nepal": "NP", "laos": "LA",
  "cambodia": "KH", "bhutan": "BT", "sri lanka": "LK",
  "iran": "IR", "israel": "IL", "uae": "AE", "united arab emirates": "AE",
  "saudi arabia": "SA", "egypt": "EG", "morocco": "MA",
  "australia": "AU", "new zealand": "NZ",
  "canada": "CA", "mexico": "MX",
  "brazil": "BR", "brasil": "BR", "argentina": "AR", "chile": "CL",
  "peru": "PE", "colombia": "CO", "ecuador": "EC", "bolivia": "BO",
  "south africa": "ZA", "kenya": "KE", "tanzania": "TZ",
  "jamaica": "JM", "puerto rico": "PR",
};

function geocode(city: string, country: string): [number, number] | null {
  // Try GeoNames first via name+country ISO — broadest coverage (~68k cities).
  const iso = COUNTRY_NAME_TO_ISO[country.toLowerCase().trim()];
  if (iso && city) {
    const gn = resolveByCityName(city, iso);
    if (gn) return gn;
  }
  // Legacy hardcoded tables. Kept so places in our dataset but outside GeoNames
  // (national parks, obscure towns) still land somewhere reasonable.
  const cityKey = city.toLowerCase().trim();
  if (cityKey && CITY_COORDS[cityKey]) return CITY_COORDS[cityKey];
  const countryKey = country.toLowerCase().trim();
  if (countryKey && COUNTRY_COORDS[countryKey]) return COUNTRY_COORDS[countryKey];
  return null;
}

export function radiusFor(count: number, maxCount: number): number {
  const safeMax = Math.max(1, maxCount);
  return Math.max(5, Math.min(14, 5 + (count / safeMax) * 9));
}

// Deterministic jitter so posts at identical coords don't draw on top of each other.
// ~0.015° ≈ 1.5 km — visible from zoom 10+, still looks clustered at low zoom.
const JITTER_DEG = 0.015;

function hash32(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** Pseudo-random in [-1, 1] seeded by two string inputs. */
function jitter1(seed: string, salt: string): number {
  const h = hash32(seed + "|" + salt);
  return ((h & 0xffff) / 0xffff) * 2 - 1;
}

export function buildMapPins(
  placesCache: Record<string, PipelineCacheEntry>,
): MapPin[] {
  const pins: MapPin[] = [];

  for (const [id, entry] of Object.entries(placesCache)) {
    if (entry.triage !== "place" || !entry.extraction) continue;
    // triage === "place" guarantees this is a PlaceExtraction
    const ext = entry.extraction as PlaceExtraction;
    // Prefer resolver-set coordinates from extraction time. Fall back to
    // name-based geocoding for older cache entries that predate the lat/lng fields.
    const coords: [number, number] | null =
      typeof ext.lat === "number" && typeof ext.lng === "number"
        ? [ext.lat, ext.lng]
        : geocode(ext.city || "", ext.country || "");
    if (!coords) continue;

    const label = ext.city && ext.city !== ext.country
      ? `${ext.city}, ${ext.country}`
      : ext.country || ext.city || "Unknown";

    // Skip jitter when we have Nominatim-level POI coords — the whole point
    // of exact coords is the pin sits on the actual venue.
    const jitterMag = ext.isExact ? 0 : JITTER_DEG;
    pins.push({
      lat: coords[0] + jitter1(id, "lat") * jitterMag,
      lng: coords[1] + jitter1(id, "lng") * jitterMag,
      label,
      count: 1,
      roostIds: [id],
    });
  }

  return pins;
}

// ── Leaflet map rendering ──

const TILE_URL_LIGHT = "https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png";
const TILE_URL_DARK = "https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png";
const TILE_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a> &copy; <a href="https://nominatim.openstreetmap.org/">Nominatim</a>';
const PIN_SIZE = 32;
const MIN_FOCUS_ZOOM = 10;

function isDarkTheme(): boolean {
  return document.body.classList.contains("theme-dark");
}

export interface PlacesMapController {
  dispose: () => void;
  /** Highlight and fly to the pin containing this roost_id. No-op if not present. */
  focusOn: (roostId: string) => void;
}

/**
 * Render an interactive Leaflet map with circle-marker pins.
 *
 * Filtering is viewport-driven: any pan/zoom (debounced 150ms) computes the
 * roostIds whose pins fall inside the current map bounds and calls
 * `onPinClick(ids)`. The initial fitBounds triggers this naturally so the
 * first paint filters to "all visible pins" — generally all of them at
 * world zoom.
 *
 * Clicking a pin flyTos to it (which triggers moveend → viewport filter).
 * Clicking the background resets to the initial bounds.
 *
 * `onPinClick(null)` is never emitted — callers always receive an array
 * (possibly empty if the viewport contains no pins).
 *
 * When a pin is clicked directly, the second argument `focusRoostId` carries
 * the clicked pin's roost_id so the consumer can expand that card at the top
 * of the gallery after filtering. Pan/zoom moves omit this argument.
 *
 * Returns a controller with `dispose()` and `focusOn(roostId)`.
 */
export function renderPlacesMap(
  container: HTMLElement,
  pins: MapPin[],
  onPinClick?: (roostIds: string[] | null, focusRoostId?: string) => void,
  getCoverUrl?: (roostId: string) => string | null,
): PlacesMapController {
  container.empty();
  container.classList.add("roost-places-map");

  const mapDiv = container.createDiv({ cls: "roost-map-container" });

  const map = L.map(mapDiv, {
    zoomControl: false,
    attributionControl: false,
    minZoom: 2,
    maxZoom: 12,
    worldCopyJump: true,
  });

  const tileUrl = isDarkTheme() ? TILE_URL_DARK : TILE_URL_LIGHT;
  L.tileLayer(tileUrl, {
    attribution: TILE_ATTR,
    subdomains: "abcd",
    maxZoom: 19,
  }).addTo(map);

  L.control.attribution({ position: "bottomright", prefix: false }).addTo(map);
  L.control.zoom({ position: "topright" }).addTo(map);

  let activePin: MapPin | null = null;

  // Track all markers for highlight management
  const markerMap = new Map<MapPin, L.Marker>();
  // roost_id → pin (first pin that contains it) for external focus calls
  const pinByRoostId = new Map<string, MapPin>();

  function highlightPin(pin: MapPin | null) {
    for (const [p, m] of markerMap) {
      const el = m.getElement()?.querySelector<HTMLElement>(".roost-map-pin");
      if (!el) continue;
      el.classList.toggle("roost-map-pin-active", p === pin);
      el.classList.toggle("roost-map-pin-dimmed", pin != null && p !== pin);
    }
  }

  // ── Viewport filter ──
  // moveend fires after any pan/zoom (user or programmatic flyTo). Debounce so
  // continuous dragging doesn't thrash the gallery. Compute visible roostIds
  // from current bounds and push to the consumer. When the move was triggered
  // by a pin click, surface that pin's id as focusRoostId so the consumer can
  // pin + expand it at the top of the gallery.
  let moveTimer: number | null = null;
  let pendingFocusId: string | null = null;
  // Suppress the next N viewport filters. Gallery-initiated focusOn() calls
  // bump this so flyTo's moveend doesn't push a setFilter that rebuilds the
  // grid and kills the card the user just expanded.
  let suppressNextViewport = 0;
  function scheduleViewportFilter() {
    if (moveTimer != null) window.clearTimeout(moveTimer);
    moveTimer = window.setTimeout(() => {
      moveTimer = null;
      if (suppressNextViewport > 0) {
        suppressNextViewport--;
        pendingFocusId = null;
        return;
      }
      if (!onPinClick) return;
      const bounds = map.getBounds();
      const visible: string[] = [];
      for (const pin of pins) {
        if (bounds.contains([pin.lat, pin.lng])) {
          for (const id of pin.roostIds) visible.push(id);
        }
      }
      const focus = pendingFocusId;
      pendingFocusId = null;
      onPinClick(visible, focus ?? undefined);
    }, 150);
  }
  map.on("moveend", scheduleViewportFilter);

  function selectPin(pin: MapPin) {
    if (activePin === pin) return;
    activePin = pin;
    highlightPin(pin);
    // User action cancels any pending gallery-initiated suppression.
    suppressNextViewport = 0;
    pendingFocusId = pin.roostIds[0] ?? null;
    // Only zoom in, never out. If the user has zoomed past MIN_FOCUS_ZOOM for
    // a detailed look, keep their zoom — just pan to the clicked pin.
    const targetZoom = Math.max(map.getZoom(), MIN_FOCUS_ZOOM);
    map.flyTo([pin.lat, pin.lng], targetZoom, { duration: 0.5 });
  }

  for (const pin of pins) {
    const coverUrl = getCoverUrl?.(pin.roostIds[0]) ?? null;
    const body = coverUrl
      ? `<img src="${coverUrl}" alt="" loading="lazy" />`
      : "";
    const icon = L.divIcon({
      className: "roost-map-pin-icon",
      html: `<div class="roost-map-pin${coverUrl ? "" : " roost-map-pin-empty"}">${body}</div>`,
      iconSize: [PIN_SIZE, PIN_SIZE],
      iconAnchor: [PIN_SIZE / 2, PIN_SIZE / 2],
    });

    const marker = L.marker([pin.lat, pin.lng], {
      icon,
      // Markers bubble clicks to the map by default — without this the
      // background-click deselect handler runs right after selectPin.
      bubblingMouseEvents: false,
      riseOnHover: true,
    }).addTo(map);

    marker.bindTooltip(pin.label, {
      direction: "top",
      offset: [0, -PIN_SIZE / 2],
      className: "roost-map-leaflet-tooltip",
    });

    marker.on("click", () => selectPin(pin));
    markerMap.set(pin, marker);
    for (const id of pin.roostIds) {
      if (!pinByRoostId.has(id)) pinByRoostId.set(id, pin);
    }
  }

  // Clicking the map background clears the highlight but does NOT zoom out —
  // zooming out on every stray click makes it hard to pick off neighboring pins.
  // The viewport filter still runs on any actual pan/zoom via moveend.
  map.on("click", () => {
    // User action cancels any pending gallery-initiated suppression.
    suppressNextViewport = 0;
    if (activePin) {
      activePin = null;
      highlightPin(null);
    }
  });

  if (pins.length > 0) {
    const bounds = L.latLngBounds(pins.map(p => [p.lat, p.lng] as L.LatLngTuple));
    map.fitBounds(bounds, { padding: [20, 20], maxZoom: 6 });
  } else {
    map.setView([20, 0], 2);
  }

  setTimeout(() => {
    if (container.isConnected) map.invalidateSize();
  }, 200);

  // Stats
  const totalPlaces = pins.reduce((s, p) => s + p.count, 0);
  const countries = new Set(pins.map(p => {
    const parts = p.label.split(", ");
    return parts[parts.length - 1];
  }));
  container.createDiv({
    cls: "roost-map-stats",
    text: `${totalPlaces} places across ${countries.size} countries`,
  });

  return {
    dispose: () => {
      if (moveTimer != null) window.clearTimeout(moveTimer);
      map.remove();
      container.empty();
    },
    focusOn: (roostId: string) => {
      const pin = pinByRoostId.get(roostId);
      if (!pin) return;
      activePin = pin;
      highlightPin(pin);
      // Skip the viewport filter moveend would otherwise fire — we don't want
      // the gallery to rebuild (which would tear down the card the user just
      // expanded) when the gallery is what drove the focus in the first place.
      suppressNextViewport++;
      const targetZoom = Math.max(map.getZoom(), MIN_FOCUS_ZOOM);
      map.flyTo([pin.lat, pin.lng], targetZoom, { duration: 0.5 });
    },
  };
}
