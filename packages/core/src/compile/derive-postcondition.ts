import { pathnameOf } from '../conditions/predicate.js';
import type { ParamValues, SurfaceObservation } from '../ports/surface.js';
import type { A11yNode, Binding, Condition, FrameInfo, TargetSpec } from '../schema/index.js';
import { looksLikeData } from './derive-target.js';

/** Roles whose text can serve as a checkpoint, most page-specific first. */
const SALIENT_RANK: Record<string, number> = { heading: 0, text: 1, columnheader: 2, cell: 3 };

function isBlank(url: string): boolean {
  return url === '' || url === 'about:blank';
}

/** `/members/10001` with memberId=10001 → `/members/:memberId` plus the params it used. */
export function canonicalizePath(
  pathname: string,
  values: ParamValues,
): { pattern: string; params: string[] } {
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
    // A segment the app generated (a confirmation or record number) differs on every run.
    if (/\d/.test(decoded) && looksLikeData(decoded)) return '*';
    return seg;
  });
  return { pattern: segments.join('/') || '/', params };
}

function salientCandidates(nodes: A11yNode[], seen: Set<string>, values: ParamValues): A11yNode[] {
  const paramValues = Object.values(values);
  return nodes
    .filter(
      (n) =>
        n.role in SALIENT_RANK &&
        n.name.length >= 3 &&
        n.name.length <= 60 &&
        !seen.has(n.name) &&
        !looksLikeData(n.name) &&
        !paramValues.some((v) => v.length >= 3 && n.name.includes(v)),
    )
    .sort((a, b) => (SALIENT_RANK[a.role] ?? 9) - (SALIENT_RANK[b.role] ?? 9));
}

/** The first text that appeared in `after` and was not in `before`; never a parameter value or data. */
export function firstNewSalientText(
  before: SurfaceObservation | undefined,
  after: SurfaceObservation,
  values: ParamValues,
): string | undefined {
  const seen = new Set((before?.nodes ?? []).map((n) => n.name));
  return salientCandidates(after.nodes, seen, values)[0]?.name;
}

/** The most page-specific text in an observation: a heading before a table cell. */
export function firstSalientText(obs: SurfaceObservation, values: ParamValues): string | undefined {
  return salientCandidates(obs.nodes, new Set(), values)[0]?.name;
}

/**
 * The frame a flow lives in: the one a step acted in when known, otherwise the deepest frame
 * with a real URL. In a frameset the top document's URL never changes.
 */
export function flowFrame(
  obs: SurfaceObservation,
  preferFramePath?: string[] | undefined,
): FrameInfo | undefined {
  const loaded = obs.frames.filter((f) => !isBlank(f.url));
  if (preferFramePath) {
    const wanted = preferFramePath.join('/');
    const match = loaded.find((f) => f.framePath.join('/') === wanted);
    if (match) return match;
  }
  return [...loaded].sort((a, b) => b.framePath.length - a.framePath.length)[0];
}

function changedFrameUrl(
  before: SurfaceObservation,
  after: SurfaceObservation,
  preferFramePath: string[] | undefined,
): FrameInfo | undefined {
  const previous = new Map(before.frames.map((f) => [f.framePath.join('/'), f.url]));
  const changed = after.frames.filter((f) => {
    const old = previous.get(f.framePath.join('/'));
    return (
      old !== undefined && !isBlank(old) && !isBlank(f.url) && pathnameOf(old) !== pathnameOf(f.url)
    );
  });
  if (changed.length === 0) return undefined;
  if (preferFramePath) {
    const wanted = preferFramePath.join('/');
    const match = changed.find((f) => f.framePath.join('/') === wanted);
    if (match) return match;
  }
  return [...changed].sort((a, b) => b.framePath.length - a.framePath.length)[0];
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
  const changed = changedFrameUrl(before, after, target?.framePath);
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
  const frame = flowFrame(after);
  const { pattern, params } = canonicalizePath(pathnameOf(frame?.url ?? after.url), values);
  return {
    condition: { id, role: 'postcondition', when: { url: pattern, timeoutMs: 5_000 } },
    bindings: params.map((param) => ({ param, field: 'postcondition.url', inferred: true })),
  };
}

/** Utility for callers that want a specific node's text as a checkpoint. */
export function textOf(node: A11yNode): string {
  return node.value ?? node.name;
}
