export interface ChipOpts {
  kind: "time" | "difficulty" | "location" | "where" | "price" | "rating" | "tag";
  value: string | number | null | undefined;
  variant?: "compact" | "full";
}

const KIND_PREFIX: Record<ChipOpts["kind"], string> = {
  time: "⏱ ",
  difficulty: "",
  location: "📍 ",
  where: "▶ ",
  price: "",
  rating: "★ ",
  tag: "",
};

export function renderChip(container: HTMLElement, opts: ChipOpts): HTMLElement | null {
  const value = opts.value;
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  if (str === "" || str === "null" || str === "undefined") return null;

  const variant = opts.variant ?? "compact";
  const chip = document.createElement("span");
  chip.className = `roost-chip roost-chip--${opts.kind} roost-chip--${variant}`;
  chip.textContent = `${KIND_PREFIX[opts.kind]}${str}`;
  container.appendChild(chip);
  return chip;
}
