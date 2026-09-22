import type {
  A11yNode,
  Action,
  Actor,
  DialogInfo,
  FrameInfo,
  SurfaceKind,
} from '../schema/index.js';

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
      reason: 'STALE_REF' | 'ACTION_FAILED' | 'NAVIGATION_FAILED' | 'MISSING_PARAM';
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
