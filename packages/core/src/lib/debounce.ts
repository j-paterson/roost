/**
 * Leading + trailing coalescer.
 *
 * `fn` fires IMMEDIATELY on the first `trigger()` (leading edge — single, user-driven
 * updates stay responsive), then any triggers within `delayMs` are coalesced into a
 * SINGLE trailing call. A burst of N rapid triggers produces exactly 2 calls (leading
 * + trailing), never N.
 *
 * This is what stops the gallery strobing during an Obsidian metadata re-index storm
 * (e.g. after a bulk vault write): the framework fires onDataUpdated hundreds of times
 * in a burst; without coalescing each one repaints the grid. With it, the grid paints
 * once at the start and once when the storm settles.
 */
export interface CoalescingTrigger {
  /** Request the work. Fires immediately if idle, else coalesces into one trailing call. */
  trigger(): void;
  /** Drop any pending trailing call (call on teardown). */
  cancel(): void;
}

export function createCoalescingTrigger(fn: () => void, delayMs: number): CoalescingTrigger {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let trailingPending = false;

  return {
    trigger(): void {
      if (timer === null) {
        // Idle → fire now (leading edge) and open the coalescing window.
        fn();
        timer = setTimeout(() => {
          timer = null;
          if (trailingPending) {
            trailingPending = false;
            fn();
          }
        }, delayMs);
      } else {
        // Inside the window → just remember that a trailing run is owed.
        trailingPending = true;
      }
    },
    cancel(): void {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      trailingPending = false;
    },
  };
}
