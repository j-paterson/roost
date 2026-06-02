/** Promo capture / encode sizes (2× legacy 1024×800 window, 1280×720 video). */

export const PROMO_WINDOW_WIDTH = Number(process.env.PROMO_WINDOW_WIDTH ?? 2048);
export const PROMO_WINDOW_HEIGHT = Number(process.env.PROMO_WINDOW_HEIGHT ?? 1600);

export const PROMO_VIDEO_WIDTH = Number(process.env.PROMO_VIDEO_WIDTH ?? 2560);
export const PROMO_VIDEO_HEIGHT = Number(process.env.PROMO_VIDEO_HEIGHT ?? 1440);

export function promoVideoScalePadFilter(): string {
  const w = PROMO_VIDEO_WIDTH;
  const h = PROMO_VIDEO_HEIGHT;
  return `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black`;
}
