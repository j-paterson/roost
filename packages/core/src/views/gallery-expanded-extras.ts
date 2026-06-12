/**
 * Gallery-specific blocks appended to expanded cards: collection row,
 * Smart Assign match trail, pipeline detail sections.
 */
import { CATEGORY_FIELD } from "@/config";
import type { MatchDetail } from "@/types/roost";
import type { BasesEntry } from "obsidian";
import { getRoostId, safeGetValue } from "@/lib/bases-entry";
import { getPipelineData, renderPipelineDetail } from "@/views/pipeline-details";

export interface ExpandedExtrasContext {
  entry: BasesEntry;
  /** Obsidian element used to create pipeline detail DOM (needs createDiv). */
  domHost: HTMLElement;
  matchDetailMap?: Map<string, MatchDetail> | null;
  onCollectionClick: (entry: BasesEntry) => void;
}

export function buildExpandedExtraElements(ctx: ExpandedExtrasContext): HTMLElement[] {
  const { entry, domHost, matchDetailMap, onCollectionClick } = ctx;
  const extraEls: HTMLElement[] = [];
  const expandedId = getRoostId(entry);

  const sourceCollection = safeGetValue(entry, "note.collection")?.toString() || null;
  const currentCategory = safeGetValue(entry, `note.${CATEGORY_FIELD}`)?.toString() || null;
  if (currentCategory || sourceCollection) {
    const colEl = document.createElement("div");
    colEl.className = "roost-expanded-collection";
    const shownCategory = currentCategory ?? sourceCollection!;
    const matches = !!(
      currentCategory &&
      sourceCollection &&
      currentCategory.trim().toLowerCase() === sourceCollection.trim().toLowerCase()
    );
    if (matches) colEl.classList.add("roost-expanded-collection-match");
    const icon = document.createElement("span");
    icon.className = "roost-expanded-collection-icon";
    icon.textContent = "\uD83D\uDCC1";
    colEl.appendChild(icon);
    const name = document.createElement("span");
    name.className = "roost-expanded-collection-name";
    name.textContent = shownCategory;
    colEl.appendChild(name);
    if (matches) {
      const check = document.createElement("span");
      check.className = "roost-expanded-collection-check";
      check.textContent = "\u2713";
      colEl.appendChild(check);
    } else if (sourceCollection && currentCategory) {
      const source = document.createElement("span");
      source.className = "roost-expanded-collection-source";
      source.textContent = `from ${sourceCollection}`;
      colEl.appendChild(source);
    }
    colEl.classList.add("roost-expanded-collection-clickable");
    colEl.setAttribute("title", "Move to…");
    colEl.addEventListener("click", (e) => {
      e.stopPropagation();
      onCollectionClick(entry);
    });
    extraEls.push(colEl);
  }

  const matchDetail = expandedId ? matchDetailMap?.get(expandedId) : null;
  if (matchDetail) {
    const matchEl = document.createElement("div");
    matchEl.className = "roost-expanded-match";
    const score = document.createElement("div");
    score.className = "roost-expanded-match-score";
    score.textContent = `Matched to "${matchDetail.collection}" — sim ${matchDetail.sim.toFixed(3)}`;
    matchEl.appendChild(score);

    const trailParts: string[] = [];
    if (matchDetail.decision) {
      const t1 = matchDetail.t1Pick ?? "∅";
      const t2 = matchDetail.t2Pick ?? "∅";
      trailParts.push(`T1→${t1}  T2→${t2}  ${matchDetail.decision}`);
    }
    if (matchDetail.cached) trailParts.push("(cached)");
    if (trailParts.length > 0) {
      const trailDiv = document.createElement("div");
      trailDiv.className = "roost-expanded-match-reason";
      trailDiv.textContent = trailParts.join("  ");
      matchEl.appendChild(trailDiv);
    }

    if (matchDetail.topCentroids && matchDetail.topCentroids.length > 1) {
      const altDiv = document.createElement("div");
      altDiv.className = "roost-expanded-match-reason";
      altDiv.textContent = `centroids: ${matchDetail.topCentroids.map((c) => `${c.name} ${c.sim.toFixed(3)}`).join(" · ")}`;
      matchEl.appendChild(altDiv);
    }

    const metaParts: string[] = [];
    if (matchDetail.ollamaCategory) metaParts.push(`topic: ${matchDetail.ollamaCategory}`);
    if (matchDetail.summarySnippet) metaParts.push(matchDetail.summarySnippet);
    if (metaParts.length > 0) {
      const metaDiv = document.createElement("div");
      metaDiv.className = "roost-expanded-match-reason";
      metaDiv.style.fontStyle = "italic";
      metaDiv.textContent = metaParts.join(" — ");
      matchEl.appendChild(metaDiv);
    }

    extraEls.push(matchEl);
  }

  if (expandedId) {
    const pipelineHit = getPipelineData(expandedId);
    if (pipelineHit) {
      const pipelineEl = domHost.createDiv();
      const source = {
        url: safeGetValue(entry, "note.url")?.toString() ?? null,
        author: safeGetValue(entry, "note.author")?.toString() ?? null,
        subcategory: safeGetValue(entry, "note.roost_subcategory")?.toString() ?? null,
      };
      renderPipelineDetail(pipelineEl, pipelineHit, source);
      extraEls.push(pipelineEl as HTMLElement);
    }
  }

  return extraEls;
}
