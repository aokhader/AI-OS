import { readFileSync } from 'node:fs';
import { type Policy, PolicySchema } from '@handsoff/core';

/**
 * Loads `config/policy.json` (or `HANDSOFF_POLICY`). Absent file → undefined and the engines use
 * their defaults; a malformed file is an error, never silently ignored.
 */
export function loadPolicy(env: Record<string, string | undefined>): Policy | undefined {
  const file = env.HANDSOFF_POLICY ?? './config/policy.json';
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  return PolicySchema.parse(JSON.parse(text));
}
