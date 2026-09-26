import { cp, mkdtemp, rm, stat } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFsStore, type ReplayResult, replay } from '@handsoff/core';
import { createApp, variants } from '@handsoff/legacy-bank';
import { createPlaywrightSurface } from '@handsoff/surface-playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

/**
 * P4 exit criterion: every injected runtime condition (D-024) is detected and answered as the
 * taxonomy says (01 §9): outcomes stop with a code, recoverables are recovered and reported as
 * events, fatal pages fail with evidence. Real headless Chromium, in-process mock app, no model.
 */
describe('replay under injected conditions', () => {
  let dataDir: string;
  let baseUrl: string;
  let close: () => Promise<void>;
  const env = { LEGACY_BANK_USER: 'teller', LEGACY_BANK_PASS: 'pw' };

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'handsoff-chaos-'));
    await cp(path.join(repoRoot, 'data/app-profiles'), path.join(dataDir, 'app-profiles'), {
      recursive: true,
    });
    await cp(path.join(repoRoot, 'data/capabilities'), path.join(dataDir, 'capabilities'), {
      recursive: true,
    });
    const app = createApp({
      variant: variants.a,
      user: env.LEGACY_BANK_USER,
      pass: env.LEGACY_BANK_PASS,
      sessionTtlMs: 60_000,
      cookieSecret: 'test',
      allowChaosHeader: true,
    });
    const server = app.listen(0);
    await new Promise<void>((r) => server.once('listening', () => r()));
    baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
    close = () => new Promise((r) => server.close(() => r()));
  });

  afterAll(async () => {
    await close();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function runWith(
    chaos: string,
    params: Record<string, string> = { memberId: '10001' },
    capabilityId = 'get-member-savings-balance',
  ): Promise<ReplayResult> {
    const store = createFsStore(dataDir);
    const capability = await store.capabilities.get(capabilityId);
    const profile = await store.appProfiles.get('acme-coreteller');
    if (!capability || !profile) throw new Error('fixtures missing');
    const surface = await createPlaywrightSurface({
      headless: true,
      extraHTTPHeaders: { 'x-handsoff-chaos': chaos },
    });
    try {
      return await replay(
        { capability, params, baseUrl, stepTimeoutMs: 8_000 },
        { surface, store, profile, env },
      );
    } finally {
      await surface.close();
    }
  }

  it('not-found: the injected miss is a business outcome at the search step', async () => {
    const result = await runWith('not-found');
    expect(result.status, JSON.stringify(result, null, 2)).toBe('outcome');
    if (result.status !== 'outcome') return;
    expect(result.code).toBe('MEMBER_NOT_FOUND');
    expect(result.atStep).toBe('s2');
    expect(result.recoveries).toEqual([]);
    expect(result.sideEffects).toBe('none');
    await stat(path.join(result.evidence.runDir, result.evidence.lastObservation ?? ''));
  }, 90_000);

  it('interstitial: the System notice is dismissed and the run still succeeds', async () => {
    const result = await runWith('interstitial');
    expect(result.status, JSON.stringify(result, null, 2)).toBe('success');
    if (result.status !== 'success') return;
    expect(result.outputs).toEqual({ savingsBalance: 1250.75 });
    expect(result.recoveries).toHaveLength(1);
    expect(result.recoveries[0]).toMatchObject({
      stepId: 's2',
      conditionId: 'system-notice',
      routine: { kind: 'dismiss' },
      attempt: 1,
      outcome: 'recovered',
    });
    expect(result.stepsRun.map((s) => s.attempts)).toEqual([1, 1, 1, 1]);
    await stat(path.join(result.evidence.runDir, 'snapshots/s2-system-notice.json'));
  }, 90_000);

  it('session-expiry: signs in again, re-runs the flow from its entry and succeeds', async () => {
    const result = await runWith('session-expiry');
    expect(result.status, JSON.stringify(result, null, 2)).toBe('success');
    if (result.status !== 'success') return;
    expect(result.outputs).toEqual({ savingsBalance: 1250.75 });
    expect(result.recoveries).toHaveLength(1);
    expect(result.recoveries[0]).toMatchObject({
      stepId: 's2',
      conditionId: 'session-expired',
      routine: { kind: 'rebootstrap' },
      attempt: 1,
      outcome: 'recovered',
    });
    const attempts = Object.fromEntries(result.stepsRun.map((s) => [s.stepId, s.attempts]));
    expect(attempts).toEqual({ s1: 2, s2: 2, s3: 1, s4: 1 });
    expect(result.sideEffects).toBe('none');
  }, 120_000);

  it('slow: the busy page is waited out with wait-retry and the run succeeds', async () => {
    const result = await runWith('slow');
    expect(result.status, JSON.stringify(result, null, 2)).toBe('success');
    if (result.status !== 'success') return;
    expect(result.recoveries).toHaveLength(1);
    expect(result.recoveries[0]).toMatchObject({
      stepId: 's2',
      conditionId: 'system-busy',
      routine: { kind: 'wait-retry' },
      outcome: 'recovered',
    });
  }, 90_000);

  it('error: the application error page is a failure with evidence, not an outcome', async () => {
    const result = await runWith('error');
    expect(result.status, JSON.stringify(result, null, 2)).toBe('failure');
    if (result.status !== 'failure') return;
    expect(result.kind).toBe('APP_ERROR');
    expect(result.atStep).toBe('s2');
    expect(result.observed).toContain('error page');
    expect(result.evidence.failingScreenshot).toBeDefined();
    await stat(path.join(result.evidence.runDir, result.evidence.failingScreenshot ?? ''));
    await stat(path.join(result.evidence.runDir, result.evidence.lastObservation ?? ''));
    expect(result.sideEffects).toBe('none');
  }, 90_000);

  it('a clean run under a chaos header that never fires is unaffected', async () => {
    const result = await runWith('validation');
    expect(result.status, JSON.stringify(result, null, 2)).toBe('success');
    if (result.status !== 'success') return;
    expect(result.recoveries).toEqual([]);
  }, 90_000);

  const subAccount = { memberId: '10001', accountType: 'Checking', deposit: '40.00' };

  it('open-sub-account: the discovered write flow replays to a confirmation number', async () => {
    const result = await runWith('not-armed', subAccount, 'open-sub-account');
    expect(result.status, JSON.stringify(result, null, 2)).toBe('success');
    if (result.status !== 'success') return;
    expect(result.outputs.confirmationNumber).toMatch(/^C-\d{6}$/);
    expect(result.stepsRun.map((s) => s.stepId)).toEqual([
      's1',
      's2',
      's3',
      's4',
      's5',
      's6',
      's7',
      's8',
    ]);
  }, 120_000);

  it('validation: a rejected submit is a business outcome at the submit step', async () => {
    const result = await runWith('validation', subAccount, 'open-sub-account');
    expect(result.status, JSON.stringify(result, null, 2)).toBe('outcome');
    if (result.status !== 'outcome') return;
    expect(result.code).toBe('VALIDATION_REJECTED');
    expect(result.atStep).toBe('s7');
    expect(result.recoveries).toEqual([]);
    await stat(path.join(result.evidence.runDir, result.evidence.lastObservation ?? ''));
  }, 120_000);
});
