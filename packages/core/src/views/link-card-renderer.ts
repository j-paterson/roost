export interface LinkCardViewData {
  url: string;
  title?: string;
  description?: string;
  site?: string;
  /** Already-resolved resource URL for the preview image (app:// or https://). */
  imageSrc?: string | null;
}

/** Render the shared horizontal link card into `parent`. Returns the card
 *  element (tagged data-link-url for click wiring) or null when url is empty. */
export function renderLinkCard(
  parent: HTMLElement,
  data: LinkCardViewData,
  opts: { compact?: boolean } = {},
): HTMLElement | null {
  if (!data.url) return null;

  const card = document.createElement("div");
  card.className = "roost-linkcard";
  if (opts.compact) card.classList.add("roost-linkcard-compact");
  card.dataset.linkUrl = data.url;
  parent.appendChild(card);

  if (data.imageSrc) {
    const thumb = document.createElement("div");
    thumb.className = "roost-linkcard-thumb";
    thumb.style.backgroundImage = `url("${data.imageSrc}")`;
    card.appendChild(thumb);
  }

  const body = document.createElement("div");
  body.className = "roost-linkcard-body";
  card.appendChild(body);

  if (data.title) {
    const t = document.createElement("div");
    t.className = "roost-linkcard-title";
    t.textContent = data.title;
    body.appendChild(t);
  }
  if (data.description) {
    const d = document.createElement("div");
    d.className = "roost-linkcard-desc";
    d.textContent = data.description;
    body.appendChild(d);
  }
  if (data.site) {
    const s = document.createElement("div");
    s.className = "roost-linkcard-site";
    s.textContent = data.site;
    body.appendChild(s);
  }

  return card;
}
