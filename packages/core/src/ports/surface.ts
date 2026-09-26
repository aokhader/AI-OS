import type {
  A11yNode,
  Action,
  Actor,
  DialogInfo,
  FrameInfo,
  SurfaceKind,
} from '../schema/index.js';

/**
 * Text a surface shows on the page it serves in place of a navigation to an origin outside the
 * policy allowlist (D-034). Core's runtime detector fails a run that lands on it.
 */
export const BLOCKED_NAVIGATION_TEXT = 'Navigation blocked by policy';

/**
 * What a surface returns from observe(). The engine persists the screenshot and adds the digest,
 * producing an `Observation`. Target resolution is a pure function over `nodes` in core
 * (resolve/resolve-target.ts); the surface only has to act on a ref from its latest observation.
 */
export interface SurfaceObservation {
  at: string;
  url: string;
  title: string;
  frames: FrameInfo[];
  nodes: A11yNode[];
  dialogs: DialogInfo[];
  screenshotPng?: Uint8Array;
}

export interface ObserveOptions {
  /** Default true. Polling waits skip the screenshot. */
  screenshot?: boolean;
  /**
   * Nodes for which this returns true are painted over in the screenshot before it is taken
   * (D-035). The engine decides what is sensitive; the surface only paints.
   */
  mask?: ((node: A11yNode) => boolean) | undefined;
}

/** Parameter values by name; the surface substitutes `{ param }` values at act time (D-013). */
export type ParamValues = Record<string, string>;

export interface ActContext {
  actor: Actor;
  values: ParamValues;
  /** Relative navigate URLs resolve against this. */
  baseUrl: string;
}

export type ActResult =
  | { ok: true; detail?: string }
  | {
      ok: false;
      reason:
        | 'STALE_REF'
        | 'ACTION_FAILED'
        | 'NAVIGATION_FAILED'
        | 'NAVIGATION_BLOCKED'
        | 'MISSING_PARAM';
      detail: string;
    };

export interface SurfaceInfo {
  kind: SurfaceKind;
  name: string;
}

export interface Surface {
  info(): SurfaceInfo;
  observe(options?: ObserveOptions): Promise<SurfaceObservation>;
  /** Targets inside `action` must be `{ ref }` values from the most recent observation. */
  act(action: Action, context: ActContext): Promise<ActResult>;
  close(): Promise<void>;
}
