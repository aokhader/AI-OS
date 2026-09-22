import { describeTarget, resolveTarget } from '../resolve/resolve-target.js';
import type { A11yNode, DialogInfo, FrameInfo, Predicate } from '../schema/index.js';

/** The parts of an observation a predicate can see. Satisfied by SurfaceObservation and Observation. */
export interface ObservationView {
  url?: string | undefined;
  title: string;
  frames: FrameInfo[];
  nodes: A11yNode[];
  dialogs: DialogInfo[];
}

/**
 * Route patterns: `:param` matches one segment, `*` matches within a segment, `**` matches across
 * segments. Matched against the pathname of the top document and of every frame.
 */
export function urlPatternToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const re = escaped
    .replace(/\*\*/g, '__GLOBSTAR__')
    .replace(/\*/g, '[^/]*')
    .replace(/__GLOBSTAR__/g, '.*')
    .replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '(?<$1>[^/]+)');
  return new RegExp(`^${re}/?$`);
}

export function pathnameOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

export function observedUrls(obs: ObservationView): string[] {
  const urls = obs.frames.map((f) => f.url);
  if (obs.url) urls.unshift(obs.url);
  return urls;
}

/** The first observed URL whose pathname matches the pattern, with any named params. */
export function matchUrl(
  pattern: string,
  obs: ObservationView,
): { url: string; params: Record<string, string> } | undefined {
  const re = urlPatternToRegex(pattern);
  for (const url of observedUrls(obs)) {
    const m = re.exec(pathnameOf(url));
    if (m) return { url, params: { ...m.groups } };
  }
  return undefined;
}

function textPresent(obs: ObservationView, text: string): boolean {
  const needle = text.replace(/\s+/g, ' ').trim();
  return obs.nodes.some((n) => n.name.includes(needle) || (n.value?.includes(needle) ?? false));
}

export function evaluatePredicate(
  p: Predicate,
  obs: ObservationView,
): { matched: boolean; detail: string } {
  const failures: string[] = [];
  if (p.url !== undefined && !matchUrl(p.url, obs)) {
    const seen = observedUrls(obs).map(pathnameOf).join(', ');
    failures.push(`url ${p.url} not matched (saw ${seen || 'nothing'})`);
  }
  for (const t of p.textPresent ?? []) {
    if (!textPresent(obs, t)) failures.push(`text "${t}" not found`);
  }
  for (const t of p.textAbsent ?? []) {
    if (textPresent(obs, t)) failures.push(`text "${t}" present`);
  }
  if (p.element) {
    const r = resolveTarget(obs.nodes, p.element);
    if (!r.found) {
      failures.push(`element not resolved: ${describeTarget(p.element)}`);
    }
  }
  if (p.dialog !== undefined) {
    const open = obs.dialogs.length > 0;
    if (open !== p.dialog) failures.push(p.dialog ? 'no dialog is open' : 'a dialog is open');
  }
  if (p.frameTitle !== undefined) {
    const t = p.frameTitle;
    if (!obs.frames.some((f) => f.title.includes(t)) && !obs.title.includes(t)) {
      failures.push(`frame title "${t}" not found`);
    }
  }
  return failures.length > 0
    ? { matched: false, detail: failures.join('; ') }
    : { matched: true, detail: 'ok' };
}

export function describePredicate(p: Predicate): string {
  const parts: string[] = [];
  if (p.url) parts.push(`url ${p.url}`);
  if (p.textPresent) parts.push(`text ${p.textPresent.map((t) => `"${t}"`).join(', ')}`);
  if (p.textAbsent) parts.push(`no text ${p.textAbsent.map((t) => `"${t}"`).join(', ')}`);
  if (p.element) parts.push(`element ${describeTarget(p.element)}`);
  if (p.dialog !== undefined) parts.push(p.dialog ? 'a dialog open' : 'no dialog open');
  if (p.frameTitle) parts.push(`frame title "${p.frameTitle}"`);
  return parts.join(' and ') || 'nothing';
}
