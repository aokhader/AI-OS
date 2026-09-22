import { pathnameOf } from '../conditions/predicate.js';
import type { ParamValues, SurfaceObservation } from '../ports/surface.js';
import type { A11yNode, Binding, Condition, TargetSpec } from '../schema/index.js';
import { looksLikeData } from './derive-target.js';

const SALIENT_ROLES = new Set(['heading', 'text', 'cell', 'columnheader']);

/** `/members/10001` with memberId=10001 → `/members/:memberId` plus the params it used. */
export function canonicalizePath(pathname: string, values: ParamValues): { pattern: string; params: string[] } {
  const params: string[] = [];
  const segments = pathname.split('/').map((seg) => {
    if (seg === '') return seg;
    const decoded = decodeURIComponent(seg);
    for (const [name, value] of Object.entries(values)) {
      if (value !== '' && decoded === value) {
        if (!params.includes(name)) params.push(name);
        return `:${name}`;
      }
    }
    return seg;
  });
  return { pattern: segments.join('/') || '/', params };
}

/** The first text that appeared in `after` and was not in `before`; never a parameter value or data. */
export function firstNewSalientText(
  before: SurfaceObservation | undefined,
  after: SurfaceObservation,
  values: ParamValues,
): string | undefined {
  const seen = new Set((before?.nodes ?? []).map((n) => n.name));
  const paramValues = Object.values(values);
  const candidate = after.nodes.find(
    (n) =>
      SALIENT_ROLES.has(n.role) &&
      n.name.length >= 3 &&
      n.name.length <= 60 &&
      !seen.has(n.name) &&
      !looksLikeData(n.name) &&
      !paramValues.some((v) => v.length >= 3 && n.name.includes(v)),
  );
  return candidate?.name;
}

/** The first salient text in an observation, preferring the frame the flow lives in. */
export function firstSalientText(obs: SurfaceObservation, values: ParamValues): string | undefined {
  return firstNewSalientText(undefined, obs, values);
}

function changedFrameUrl(
  before: SurfaceObservation,
  after: SurfaceObservation,
): { framePath: string[]; url: string } | undefined {
  const previous = new Map(before.frames.map((f) => [f.framePath.join('/'), f.url]));
  // Prefer nested frames: in a frameset the top URL never changes.
  const frames = [...after.frames].sort((a, b) => b.framePath.length - a.framePath.length);
  for (const f of frames) {
    const old = previous.get(f.framePath.join('/'));
    if (old !== undefined && pathnameOf(old) !== pathnameOf(f.url)) {
      return { framePath: f.framePath, url: f.url };
    }
  }
  return undefined;
}

export interface DerivedPostcondition {
  condition: Condition;
  bindings: Binding[];
}

/**
 * Proposes a checkpoint for a recorded step from the observation deltas around it (§7): a URL
 * change becomes a canonicalised route pattern, newly visible text becomes textPresent, and a
 * step that changed nothing observable is checked by its own target still resolving.
 */
export function derivePostcondition(
  stepId: string,
  before: SurfaceObservation,
  after: SurfaceObservation,
  target: TargetSpec | undefined,
  values: ParamValues,
): DerivedPostcondition {
  const id = `${stepId}-post`;
  const changed = changedFrameUrl(before, after);
  const newText = firstNewSalientText(before, after, values);

  if (changed) {
    const { pattern, params } = canonicalizePath(pathnameOf(changed.url), values);
    return {
      condition: {
        id,
        role: 'postcondition',
        when: { url: pattern, ...(newText ? { textPresent: [newText] } : {}), timeoutMs: 10_000 },
      },
      bindings: params.map((param) => ({ param, field: 'postcondition.url', inferred: true })),
    };
  }
  if (newText) {
    return {
      condition: { id, role: 'postcondition', when: { textPresent: [newText], timeoutMs: 10_000 } },
      bindings: [],
    };
  }
  if (target) {
    return {
      condition: { id, role: 'postcondition', when: { element: target, timeoutMs: 5_000 } },
      bindings: [],
    };
  }
  const main = [...after.frames].sort((a, b) => b.framePath.length - a.framePath.length)[0];
  const { pattern, params } = canonicalizePath(pathnameOf(main?.url ?? after.url), values);
  return {
    condition: { id, role: 'postcondition', when: { url: pattern, timeoutMs: 5_000 } },
    bindings: params.map((param) => ({ param, field: 'postcondition.url', inferred: true })),
  };
}

/** Utility for callers that want a specific node's text as a checkpoint. */
export function textOf(node: A11yNode): string {
  return node.value ?? node.name;
}
