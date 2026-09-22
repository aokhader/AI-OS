/**
 * @handsoff/surface-playwright
 *
 * Implements the `Surface` port from @handsoff/core over Playwright (Chromium):
 * observe (accessibility snapshot with refs, frame paths, screenshot, dialogs), act, resolve with
 * the three locator strategies, and human-action capture for the handoff.
 *
 * Built in phase P1. See docs/context/01-architecture.md §5 and §8.
 */
export const SURFACE_KIND = 'legacy-web' as const;
