import { cp, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFsStore, replay } from '@handsoff/core';
import { createApp, variants } from '@handsoff/legacy-bank';
import { createPlaywrightSurface } from '@handsoff/surface-playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

/**
 * The P1 exit criterion, automated: the hand-written capability replays against the real mock app
 * through a real (headless) Chromium with zero LLM involvement. No API key, no network.
 */
describe('replay against legacy-bank', () => {
  let dataDir: string;
  let baseUrl: string;
  let close: () => Promise<void>;
  const env = { LEGACY_BANK_USER: 'teller', LEGACY_BANK_PASS: 'pw' };

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'handsoff-'));
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

  async function runWith(params: Record<string, string>) {
    const store = createFsStore(dataDir);
    const capability = await store.capabilities.get('get-member-savings-balance');
    const profile = await store.appProfiles.get('acme-coreteller');
    if (!capability || !profile) throw new Error('fixtures missing');
    const surface = await createPlaywrightSurface({ headless: true });
    try {
      return await replay({ capability, params, baseUrl }, { surface, store, profile, env });
    } finally {
      await surface.close();
    }
  }

  it('returns the savings balance for a known member', async () => {
    const result = await runWith({ memberId: '10001' });
    expect(result.status, JSON.stringify(result, null, 2)).toBe('success');
    if (result.status !== 'success') return;
    expect(result.outputs).toEqual({ savingsBalance: 1250.75 });
    expect(result.stepsRun.map((s) => s.stepId)).toEqual(['s1', 's2', 's3', 's4']);
    expect(result.stepsRun.every((s) => s.resolvedBy === 0 && !s.drift)).toBe(true);
    expect(result.sideEffects).toBe('none');
    expect(result.recoveries).toEqual([]);

    // evidence: run folder with events, screenshots and a result
    await stat(path.join(result.evidence.runDir, 'run.json'));
    await stat(path.join(result.evidence.runDir, 'result.json'));
    const events = (await readFile(path.join(result.evidence.runDir, 'events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { type: string; stepId?: string; screenshot?: string });
    const types = new Set(events.map((e) => e.type));
    for (const t of ['observation', 'decision', 'policy_check', 'action', 'condition', 'result']) {
      expect(types.has(t), `missing event type ${t}`).toBe(true);
    }
    const shot = events.find((e) => e.type === 'observation' && e.screenshot);
    expect(shot?.screenshot).toBeDefined();
    await stat(path.join(result.evidence.runDir, shot?.screenshot ?? ''));
  }, 90_000);

  it('reports an unknown member as a business outcome, not a failure', async () => {
    const result = await runWith({ memberId: '99999' });
    expect(result.status, JSON.stringify(result, null, 2)).toBe('outcome');
    if (result.status !== 'outcome') return;
    expect(result.code).toBe('MEMBER_NOT_FOUND');
    expect(result.atStep).toBe('s2');
    expect(result.stepsRun.map((s) => s.stepId)).toEqual(['s1']);
    await stat(path.join(result.evidence.runDir, result.evidence.lastObservation ?? ''));
  }, 90_000);
});
