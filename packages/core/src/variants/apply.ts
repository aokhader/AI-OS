import { matchUrl, type ObservationView } from '../conditions/predicate.js';
import {
  type Action,
  type AppProfile,
  type Capability,
  CapabilitySchema,
  type Condition,
  type Fingerprint,
  type Predicate,
  type Strategy,
  type TargetSpec,
} from '../schema/index.js';

/** True when every clause of the fingerprint holds on the observation. */
export function matchFingerprint(fp: Fingerprint, obs: ObservationView): boolean {
  const titles = [obs.title, ...obs.frames.map((f) => f.title)];
  const text = (needle: string) =>
    obs.nodes.some((n) => n.name.includes(needle) || (n.value?.includes(needle) ?? false));
  if (fp.titleIncludes !== undefined) {
    const needle = fp.titleIncludes;
    if (!titles.some((t) => t.includes(needle))) return false;
  }
  if (fp.textPresent !== undefined && !fp.textPresent.every(text)) return false;
  if (fp.versionBanner !== undefined && !text(fp.versionBanner)) return false;
  if (fp.urlPattern !== undefined && !matchUrl(fp.urlPattern, obs)) return false;
  return true;
}

/** Ids of every variant whose fingerprint holds, in profile order. */
export function detectVariants(profile: AppProfile, obs: ObservationView): string[] {
  return Object.entries(profile.variants)
    .filter(([, v]) => matchFingerprint(v.fingerprint, obs))
    .map(([id]) => id);
}

export interface OverrideCounts {
  labels: number;
  routes: number;
  frames: number;
  steps: number;
  detectors: number;
}

export interface AppliedVariant {
  variantId: string;
  capability: Capability;
  counts: OverrideCounts;
}

/**
 * The capability as it runs on one variant (01 §14, D-037): profile overrides first (labels,
 * routes, frames, detectors), then the capability's own per-step replacements for that variant.
 * Pure; the result is validated so an override can never produce an artifact the schema rejects.
 */
export function applyVariant(
  capability: Capability,
  profile: AppProfile,
  variantId: string,
): AppliedVariant {
  const variant = profile.variants[variantId];
  if (!variant) throw new Error(`profile ${profile.vendorProductId} has no variant ${variantId}`);
  const labels = variant.overrides.labels ?? {};
  const routes = variant.overrides.routes ?? {};
  const frames = variant.overrides.frames ?? {};
  const counts: OverrideCounts = { labels: 0, routes: 0, frames: 0, steps: 0, detectors: 0 };

  const label = (s: string): string => {
    const to = labels[s];
    if (to === undefined) return s;
    counts.labels += 1;
    return to;
  };
  const route = (s: string): string => {
    const to = routes[s];
    if (to === undefined) return s;
    counts.routes += 1;
    return to;
  };
  const framePath = (path: string[]): string[] =>
    path.map((f) => {
      const to = frames[f];
      if (to === undefined) return f;
      counts.frames += 1;
      return to;
    });
  const strategy = (s: Strategy): Strategy => {
    switch (s.kind) {
      case 'role':
        return { ...s, name: label(s.name) };
      case 'anchored':
        return {
          ...s,
          anchor: label(s.anchor),
          ...(s.column !== undefined ? { column: label(s.column) } : {}),
        };
      case 'structural':
        return s;
    }
  };
  const spec = (t: TargetSpec): TargetSpec => ({
    strategies: t.strategies.map(strategy),
    framePath: framePath(t.framePath),
  });
  const predicate = (p: Predicate): Predicate => ({
    ...p,
    ...(p.url !== undefined ? { url: route(p.url) } : {}),
    ...(p.textPresent !== undefined ? { textPresent: p.textPresent.map(label) } : {}),
    ...(p.textAbsent !== undefined ? { textAbsent: p.textAbsent.map(label) } : {}),
    ...(p.element !== undefined ? { element: spec(p.element) } : {}),
  });
  const condition = (c: Condition): Condition => ({
    ...c,
    when: predicate(c.when),
    ...(c.recovery?.kind === 'dismiss'
      ? { recovery: { ...c.recovery, target: spec(c.recovery.target) } }
      : {}),
  });
  const action = (a: Action): Action => {
    switch (a.kind) {
      case 'click':
      case 'type':
      case 'select':
      case 'extract':
        return 'spec' in a.target ? { ...a, target: { spec: spec(a.target.spec) } } : a;
      case 'navigate':
        return 'text' in a.url ? { ...a, url: { text: route(a.url.text) } } : a;
      default:
        return a;
    }
  };

  const own = capability.variants?.[variantId];
  const steps = capability.steps.map((s) => {
    const base = {
      ...s,
      action: action(s.action),
      ...(s.target ? { target: spec(s.target) } : {}),
      preconditions: s.preconditions.map(condition),
      postcondition: condition(s.postcondition),
    };
    const o = own?.steps?.[s.id];
    if (!o) return base;
    counts.steps += 1;
    const target = o.target ?? base.target;
    const targeted =
      base.action.kind !== 'press' &&
      base.action.kind !== 'wait' &&
      base.action.kind !== 'navigate';
    return {
      ...base,
      ...(target ? { target } : {}),
      action: targeted && o.target ? { ...base.action, target: { spec: o.target } } : base.action,
      ...(o.postcondition ? { postcondition: o.postcondition } : {}),
      ...(o.preconditions ? { preconditions: o.preconditions } : {}),
    } as Capability['steps'][number];
  });
  const extraDetectors = [...(variant.overrides.detectors ?? []), ...(own?.detectors ?? [])];
  counts.detectors = extraDetectors.length;

  const rewritten: Capability = {
    ...capability,
    entry: {
      ...capability.entry,
      route: route(capability.entry.route),
      preconditions: capability.entry.preconditions.map(condition),
    },
    outputs: capability.outputs.map((o) => ({
      ...o,
      source: 'urlParam' in o.source ? o.source : spec(o.source),
    })),
    steps,
    success: condition(capability.success),
    detectors: [...capability.detectors.map(condition), ...extraDetectors],
  };
  return { variantId, capability: CapabilitySchema.parse(rewritten), counts };
}
