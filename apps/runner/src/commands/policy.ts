import { readFileSync } from 'node:fs';
import { type Policy, PolicySchema } from '@handsoff/core';

export function policyFile(env: Record<string, string | undefined>): string {
  return env.HANDSOFF_POLICY ?? './config/policy.json';
}

/**
 * Loads `config/policy.json` (or `HANDSOFF_POLICY`). Absent file → undefined; a malformed file is
 * an error, never silently ignored.
 */
export function loadPolicy(env: Record<string, string | undefined>): Policy | undefined {
  const file = policyFile(env);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  return PolicySchema.parse(JSON.parse(text));
}

/** The engines never run without a policy from the CLI (01 §12): nothing acts without the gate. */
export function requirePolicy(
  env: Record<string, string | undefined>,
): { ok: true; policy: Policy } | { ok: false; error: string } {
  const policy = loadPolicy(env);
  if (!policy) {
    return {
      ok: false,
      error: `policy file ${policyFile(env)} not found; the gate needs one (set HANDSOFF_POLICY to use another path)`,
    };
  }
  return { ok: true, policy };
}
