import { randomBytes } from 'node:crypto';
import { type VariantConfig, type VariantKey, variants } from './variants.js';

export interface AppConfig {
  variant: VariantConfig;
  user: string;
  pass: string;
  sessionTtlMs: number;
  cookieSecret: string;
  /** Honour the x-handsoff-chaos header (P4). */
  allowChaosHeader: boolean;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) throw new Error(`${name} must be an integer, got ${raw}`);
  return n;
}

export function configFromEnv(): AppConfig & { port: number } {
  const key = (process.env.LEGACY_BANK_VARIANT ?? 'a').toLowerCase() as VariantKey;
  const variant = variants[key];
  if (!variant) throw new Error(`LEGACY_BANK_VARIANT must be a or b, got ${key}`);
  const port =
    key === 'b' ? intEnv('LEGACY_BANK_PORT_B', 4101) : intEnv('LEGACY_BANK_PORT_A', 4100);
  return {
    variant,
    port,
    user: process.env.LEGACY_BANK_USER ?? 'teller',
    pass: process.env.LEGACY_BANK_PASS ?? 'teller-demo-password',
    sessionTtlMs: intEnv('LEGACY_BANK_SESSION_TTL_MS', 30 * 60 * 1000),
    cookieSecret: process.env.LEGACY_BANK_COOKIE_SECRET ?? randomBytes(16).toString('hex'),
    allowChaosHeader: (process.env.LEGACY_BANK_ALLOW_CHAOS_HEADER ?? 'true') !== 'false',
  };
}
