/**
 * @handsoff/surface-playwright
 *
 * Implements the `Surface` port from @handsoff/core over Playwright (Chromium): observation as a
 * flattened accessibility-style node list with refs, frame paths, bounding boxes and structural
 * paths, plus a screenshot; actions on refs from the latest observation; native dialog tracking.
 * Human-action capture for the handoff arrives in P6.
 *
 * Target resolution is deliberately not here: it is a pure function in core over the observation.
 * See docs/context/01-architecture.md §5 and §8.
 */

export { type RawSnapshot, type RawSnapshotNode, snapshotDocument } from './snapshot.js';
export {
  createPlaywrightSurface,
  PlaywrightSurface,
  type PlaywrightSurfaceOptions,
} from './surface.js';
