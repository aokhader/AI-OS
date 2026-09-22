import { createHash } from 'node:crypto';
import type { ObservationView } from './conditions/predicate.js';

/** Stable hash of what matters for change detection: URLs, roles, names, values, structure. */
export function digestOf(obs: ObservationView): string {
  const h = createHash('sha256');
  h.update(obs.url ?? '');
  for (const f of obs.frames) h.update(`\n#${f.framePath.join('/')} ${f.url}`);
  for (const n of obs.nodes) {
    h.update(`\n${n.framePath.join('/')}|${n.path}|${n.role}|${n.name}|${n.value ?? ''}`);
  }
  for (const d of obs.dialogs) h.update(`\n!${d.kind}|${d.text}`);
  return h.digest('hex').slice(0, 24);
}
