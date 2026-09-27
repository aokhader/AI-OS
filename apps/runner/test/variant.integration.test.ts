import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type Capability,
  createFsStore,
  type Policy,
  PolicySchema,
  type ReplayResult,
  type RunEvent,
  replay,
} from '@handsoff/core';
import { createApp, variants } from '@handsoff/legacy-bank';
import { createPlaywrightSurface } from '@handsoff/surface-playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

/**
 * P7 exit criterion (04): the capability recorded on variant A succeeds on variant B with the
 * profile's overrides, every step resolving by its first strategy; an unknown or contradicted
 * fingerprint is DRIFT_SUSPECTED before any step runs. Both variants run in-process.
 */
describe('cross-tenant replay', () => {
  let dataDir: string;
  let urlA: string;
  let urlB: string;
  let policy: Policy;
  const closers: Array<() => Promise<void>> = [];
  const env = { LEGACY_BANK_USER: 'teller', LEGACY_BANK_PASS: 'pw' };

  async function start(variant: typeof variants.a): Promise<string> {
    const app = createApp({
      variant,
      user: env.LEGACY_BANK_USER,
      pass: env.LEGACY_BANK_PASS,
      sessionTtlMs: 60_000,
      cookieSecret: 'test',
      allowChaosHeader: true,
    });
    const server = app.listen(0);
    await new Promise<void>((r) => server.once('listening', () => r()));
    closers.push(() => new Promise((r) => server.close(() => r())));
    return `http://localhost:${(server.address() as AddressInfo).port}`;
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'handsoff-variant-'));
    for (const dir of ['app-profiles', 'capabilities']) {
      await cp(path.join(repoRoot, 'data', dir), path.join(dataDir, dir), { recursive: true });
    }
    urlA = await start(variants.a);
    urlB = await start(variants.b);
    const fromRepo = PolicySchema.parse(
      JSON.parse(await readFile(path.join(repoRoot, 'config/policy.json'), 'utf8')),
    );
    policy = { ...fromRepo, allowedOrigins: [urlA, urlB] };
  });

  afterAll(async () => {
    for (const close of closers) await close();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function events(runDir: string): Promise<RunEvent[]> {
    const text = await readFile(path.join(runDir, 'events.jsonl'), 'utf8');
    return text
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as RunEvent);
  }

  async function run(
    baseUrl: string,
    params: Record<string, string>,
    options: { variantId?: string | undefined; capability?: Capability | undefined } = {},
  ): Promise<ReplayResult> {
    const store = createFsStore(dataDir);
    const capability =
      options.capability ?? (await store.capabilities.get('get-member-savings-balance'));
    const profile = await store.appProfiles.get('acme-coreteller');
    if (!capability || !profile) throw new Error('fixtures missing');
    const surface = await createPlaywrightSurface({
      headless: true,
      allowedOrigins: policy.allowedOrigins,
    });
    try {
      return await replay(
        { capability, params, baseUrl, policy, variantId: options.variantId, stepTimeoutMs: 8_000 },
        { surface, store, profile, env },
      );
    } finally {
      await surface.close();
    }
  }

  it('the A-recorded capability succeeds on variant B with the overrides, every step by its first strategy', async () => {
    const result = await run(urlB, { memberId: '10001' }, { variantId: 'sample-federal-cu' });
    expect(result.status, JSON.stringify(result, null, 2)).toBe('success');
    if (result.status !== 'success') return;
    expect(result.outputs).toEqual({ savingsBalance: 1250.75 });
    expect(result.variantId).toBe('sample-federal-cu');
    expect(result.stepsRun.map((s) => [s.stepId, s.resolvedBy, s.candidateCount, s.drift])).toEqual(
      [
        ['s1', 0, 1, false],
        ['s2', 0, 1, false],
        ['s3', 0, 1, false],
        ['s4', 0, 1, false],
      ],
    );
    const variant = (await events(result.evidence.runDir)).find((e) => e.type === 'variant');
    expect(variant).toMatchObject({
      requested: 'sample-federal-cu',
      matched: ['sample-federal-cu'],
      variantId: 'sample-federal-cu',
    });
    expect(variant?.type === 'variant' && variant.overrides?.frames).toBeGreaterThan(0);
    expect(variant?.type === 'variant' && variant.overrides?.labels).toBeGreaterThan(0);
    const runRecord = await createFsStore(dataDir).runs.get(path.basename(result.evidence.runDir));
    expect(runRecord?.target.variantId).toBe('sample-federal-cu');
  }, 90_000);

  it('detects the variant by fingerprint when none is requested', async () => {
    const b = await run(urlB, { memberId: '10001' });
    expect(b.status, JSON.stringify(b, null, 2)).toBe('success');
    expect(b.variantId).toBe('sample-federal-cu');
    const a = await run(urlA, { memberId: '99999' });
    expect(a.status).toBe('outcome');
    expect(a.variantId).toBe('first-example-cu');
  }, 120_000);

  it('a requested variant the page contradicts is DRIFT_SUSPECTED before any step runs', async () => {
    const result = await run(urlB, { memberId: '10001' }, { variantId: 'first-example-cu' });
    expect(result.status).toBe('failure');
    if (result.status !== 'failure') return;
    expect(result.kind).toBe('DRIFT_SUSPECTED');
    expect(result.atStep).toBe('entry');
    expect(result.observed).toContain('sample-federal-cu');
    expect(result.stepsRun).toEqual([]);
    expect(result.evidence.lastObservation).toBeDefined();
  }, 90_000);

  it('a page that matches no known variant is DRIFT_SUSPECTED, never the base variant', async () => {
    const store = createFsStore(dataDir);
    const profile = await store.appProfiles.get('acme-coreteller');
    const capability = await store.capabilities.get('get-member-savings-balance');
    if (!profile || !capability) throw new Error('fixtures missing');
    const unknown = {
      ...profile,
      variants: {
        'other-cu': {
          name: 'Other CU',
          fingerprint: { titleIncludes: 'Other Credit Union' },
          overrides: {},
        },
      },
    };
    const surface = await createPlaywrightSurface({
      headless: true,
      allowedOrigins: policy.allowedOrigins,
    });
    let result: ReplayResult;
    try {
      result = await replay(
        { capability, params: { memberId: '10001' }, baseUrl: urlA, policy },
        { surface, store, profile: unknown, env },
      );
    } finally {
      await surface.close();
    }
    expect(result.status).toBe('failure');
    if (result.status !== 'failure') return;
    expect(result.kind).toBe('DRIFT_SUSPECTED');
    expect(result.observed).toContain('no known variant');
  }, 90_000);

  it('the write flow runs on variant B too: the same label map carries it', async () => {
    const store = createFsStore(dataDir);
    const c = await store.capabilities.get('open-sub-account');
    if (!c) throw new Error('open-sub-account missing');
    const approved: Capability = {
      ...c,
      status: 'approved',
      steps: c.steps.map((s) => (s.id === 's7' ? { ...s, risk: 'risky', confirm: 'none' } : s)),
      policy: { ...c.policy, riskySteps: ['s7'] },
    };
    const result = await run(
      urlB,
      { memberId: '10001', accountType: 'Checking', deposit: '15.00' },
      { capability: approved },
    );
    expect(result.status, JSON.stringify(result, null, 2)).toBe('success');
    if (result.status !== 'success') return;
    expect(result.outputs.confirmationNumber).toMatch(/^C-\d{6}$/);
    expect(result.variantId).toBe('sample-federal-cu');
    expect(result.stepsRun.every((s) => s.resolvedBy === 0 && !s.drift)).toBe(true);
  }, 120_000);
});
