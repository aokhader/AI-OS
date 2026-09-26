import { createHash } from 'node:crypto';
import type { SurfaceObservation } from './ports/surface.js';
import type { A11yNode, OutputSpec } from './schema/index.js';

export interface SensitiveValue {
  name: string;
  value: string;
}

export interface RedactOptions {
  /**
   * Persisted text carries a hash of the value so an audit can correlate runs without storing it
   * (D-035); text shown to the model carries the bare parameter name.
   */
  hash?: boolean | undefined;
}

/** Values shorter than this are not redacted by substring: too many false positives. */
const MIN_LENGTH = 3;

export function hashValue(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 12)}`;
}

/** `«memberId»` for the model, `«memberId#sha256:…»` for anything persisted. */
export function placeholder(name: string, value: string, hash: boolean): string {
  return hash ? `«${name}#${hashValue(value)}»` : `«${name}»`;
}

/** Replaces every occurrence of a sensitive value with its placeholder. Longest values first. */
export function redactText(
  text: string,
  sensitive: SensitiveValue[],
  options: RedactOptions = {},
): string {
  let out = text;
  for (const s of [...sensitive].sort((a, b) => b.value.length - a.value.length)) {
    if (s.value.length < MIN_LENGTH) continue;
    out = out.split(s.value).join(placeholder(s.name, s.value, options.hash ?? false));
  }
  return out;
}

/** True when the node's name or value shows a sensitive value: it is painted over in screenshots. */
export function shouldMask(
  node: Pick<A11yNode, 'name' | 'value'>,
  sensitive: SensitiveValue[],
): boolean {
  return sensitive.some(
    (s) =>
      s.value.length >= MIN_LENGTH &&
      (node.name.includes(s.value) || (node.value?.includes(s.value) ?? false)),
  );
}

/**
 * An observation safe to show a model: names, values and URLs redacted with bare placeholders.
 * The screenshot is already masked by the surface.
 */
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
      ...(n.formAction !== undefined ? { formAction: r(n.formAction) } : {}),
    })),
    dialogs: obs.dialogs.map((d) => ({ ...d, text: r(d.text) })),
  };
}

/** Deep-redacts any JSON-serialisable value bound for disk (events, snapshots, transcripts). */
export function redactJson<T>(value: T, sensitive: SensitiveValue[]): T {
  if (sensitive.length === 0) return value;
  return JSON.parse(redactText(JSON.stringify(value), sensitive, { hash: true })) as T;
}

/**
 * Outputs as they are persisted: sensitive and secret values become hashed placeholders. The
 * in-process result keeps the real values (01 §12).
 */
export function maskOutputs(
  outputs: Record<string, unknown>,
  specs: OutputSpec[],
): Record<string, unknown> {
  const masked: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(outputs)) {
    const spec = specs.find((s) => s.name === name);
    const hide = spec?.sensitivity === 'sensitive' || spec?.sensitivity === 'secret';
    masked[name] = hide && value !== undefined ? placeholder(name, String(value), true) : value;
  }
  return masked;
}
