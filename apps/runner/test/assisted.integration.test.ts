import { cp, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createFsStore,
  createScriptedRecoveryPlanner,
  type Policy,
  PolicySchema,
  type RecoveryPlanner,
  type ReplayResult,
  replay,
  type ScriptedStep,
} from '@handsoff/core';
import { createApp, variants } from '@handsoff/legacy-bank';
import { createPlaywrightSurface } from '@handsoff/surface-playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

/**
 * Assisted fallback (01 §15, D-038): under the `relabel` chaos the search button is renamed and
 * moved, so no recorded strategy finds it. With the policy switch on and a recovery planner
 * attached, one proposed action stands in for the step; otherwise the failure stands.
 */
describe('assisted fallback', () => {
  let dataDir: string;
  let baseUrl: string;
  let base: Policy;
  let close: () => Promise<void>;
  const env = { LEGACY_BANK_USER: 'teller', LEGACY_BANK_PASS: 'pw' };

  const clickLookUp: ScriptedStep = {
    kind: 'click',
    intent: 'the relabelled search button',
    target: {
      strategies: [{ kind: 'role', role: 'button', name: 'Look up member' }],
      framePath: ['main'],
    },
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'handsoff-assisted-'));
    for (const dir of ['app-profiles', 'capabilities']) {
      await cp(path.join(repoRoot, 'data', dir), path.join(dataDir, dir), { recursive: true });
    }
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
    const fromRepo = PolicySchema.parse(
      JSON.parse(await readFile(path.join(repoRoot, 'config/policy.json'), 'utf8')),
    );
    base = { ...fromRepo, allowedOrigins: [baseUrl] };
  });

  afterAll(async () => {
    await close();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function run(options: {
    planner?: RecoveryPlanner | undefined;
    enabled?: boolean | undefined;
    maxPerRun?: number | undefined;
  }): Promise<ReplayResult> {
    const store = createFsStore(dataDir);
    const capability = await store.capabilities.get('get-member-savings-balance');
    const profile = await store.appProfiles.get('acme-coreteller');
    if (!capability || !profile) throw new Error('fixtures missing');
    const policy: Policy = {
      ...base,
      assistedFallback: { enabled: options.enabled ?? true, maxPerRun: options.maxPerRun ?? 2 },
    };
    const surface = await createPlaywrightSurface({
      headless: true,
      allowedOrigins: policy.allowedOrigins,
      extraHTTPHeaders: { 'x-handsoff-chaos': 'relabel' },
    });
    try {
      return await replay(
        { capability, params: { memberId: '10001' }, baseUrl, policy, stepTimeoutMs: 8_000 },
        { surface, store, profile, env, recoveryPlanner: options.planner },
      );
    } finally {
      await surface.close();
    }
  }

  it('one proposed action stands in for the step whose target is gone, re-verified by its postcondition', async () => {
    const result = await run({ planner: createScriptedRecoveryPlanner([clickLookUp]) });
    expect(result.status, JSON.stringify(result, null, 2)).toBe('success');
    if (result.status !== 'success') return;
    expect(result.outputs).toEqual({ savingsBalance: 1250.75 });
    expect(result.recoveries).toHaveLength(1);
    expect(result.recoveries[0]).toMatchObject({
      stepId: 's2',
      conditionId: 's2-post',
      routine: { kind: 'assisted' },
      attempt: 1,
      outcome: 'recovered',
      proposal: { kind: 'click' },
    });
    const s2 = result.stepsRun.find((s) => s.stepId === 's2');
    expect(s2?.drift).toBe(true);
    expect(result.sideEffects).toBe('none');
    await stat(path.join(result.evidence.runDir, 'transcript.assisted.jsonl'));
    const events = await readFile(path.join(result.evidence.runDir, 'events.jsonl'), 'utf8');
    expect(events).toContain('"intent":"assisted recovery of s2"');
  }, 90_000);

  it('with the policy switch off the failure stands and no model is asked', async () => {
    let asked = 0;
    const planner: RecoveryPlanner = {
      info: () => ({ model: 'never' }),
      proposeOne: async () => {
        asked += 1;
        return null;
      },
    };
    const result = await run({ planner, enabled: false });
    expect(result.status).toBe('failure');
    if (result.status !== 'failure') return;
    expect(result.kind).toBe('TARGET_NOT_FOUND');
    expect(result.atStep).toBe('s2');
    expect(result.recoveries).toEqual([]);
    expect(asked).toBe(0);
  }, 90_000);

  it('a proposal the gate refuses, or none at all, leaves the original failure in place', async () => {
    const offAllowlist = await run({
      planner: createScriptedRecoveryPlanner([
        { kind: 'navigate', intent: 'somewhere else', url: { text: 'https://example.com/' } },
      ]),
    });
    expect(offAllowlist.status).toBe('failure');
    if (offAllowlist.status !== 'failure') return;
    expect(offAllowlist.kind).toBe('TARGET_NOT_FOUND');
    expect(offAllowlist.recoveries[0]).toMatchObject({
      routine: { kind: 'assisted' },
      outcome: 'failed',
      proposal: { kind: 'navigate' },
    });

    const nothing = await run({ planner: createScriptedRecoveryPlanner([]) });
    expect(nothing.status).toBe('failure');
    if (nothing.status !== 'failure') return;
    expect(nothing.kind).toBe('TARGET_NOT_FOUND');
    expect(nothing.recoveries[0]).toMatchObject({
      routine: { kind: 'assisted' },
      outcome: 'failed',
    });
    expect(nothing.recoveries[0]?.proposal).toBeUndefined();
  }, 120_000);

  it('the per-run budget is honoured', async () => {
    const result = await run({
      planner: createScriptedRecoveryPlanner([clickLookUp]),
      maxPerRun: 0,
    });
    expect(result.status).toBe('failure');
    if (result.status !== 'failure') return;
    expect(result.kind).toBe('TARGET_NOT_FOUND');
    expect(result.recoveries).toEqual([]);
  }, 90_000);
});
