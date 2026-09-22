import { createHash } from 'node:crypto';
import type { SurfaceObservation } from './ports/surface.js';

export interface SensitiveValue {
  name: string;
  value: string;
}

/** Values shorter than this are not redacted by substring: too many false positives. */
const MIN_LENGTH = 3;

/** Replaces every occurrence of a sensitive value with «name». Longest values first. */
export function redactText(text: string, sensitive: SensitiveValue[]): string {
  let out = text;
  for (const s of [...sensitive].sort((a, b) => b.value.length - a.value.length)) {
    if (s.value.length < MIN_LENGTH) continue;
    out = out.split(s.value).join(`«${s.name}»`);
  }
  return out;
}

export function hashValue(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 12)}`;
}

/** An observation safe to show a model or persist: names, values and URLs redacted; screenshot untouched (masking is P5). */
export function redactObservation(
  obs: SurfaceObservation,
  sensitive: SensitiveValue[],
): SurfaceObservation {
  if (sensitive.length === 0) return obs;
  const r = (t: string) => redactText(t, sensitive);
  return {
    ...obs,
    url: r(obs.url),
    title: r(obs.title),
    frames: obs.frames.map((f) => ({ ...f, url: r(f.url), title: r(f.title) })),
    nodes: obs.nodes.map((n) => ({
      ...n,
      name: r(n.name),
      ...(n.value !== undefined ? { value: r(n.value) } : {}),
    })),
    dialogs: obs.dialogs.map((d) => ({ ...d, text: r(d.text) })),
  };
}

/** Deep-redacts any JSON-serialisable value (transcripts, snapshots). */
export function redactJson<T>(value: T, sensitive: SensitiveValue[]): T {
  if (sensitive.length === 0) return value;
  return JSON.parse(redactText(JSON.stringify(value), sensitive)) as T;
}
