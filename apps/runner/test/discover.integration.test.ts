import { cp, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createFsStore,
  createScriptedPlanner,
  discover,
  replay,
  ScriptSchema,
} from '@handsoff/core';
import { createApp, variants } from '@handsoff/legacy-bank';
import { createPlaywrightSurface } from '@handsoff/surface-playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

/**
 * The full thread with no model: discover with a scripted planner → compile → the compiled
 * capability replays deterministically. Also checks that the recorded parameter value never
 * reaches the artifact, the event log or the transcript.
 */
describe('discover → compile → replay', () => {
  let dataDir: string;
  let baseUrl: string;
  let close: () => Promise<void>;
  const env = { LEGACY_BANK_USER: 'teller', LEGACY_BANK_PASS: 'pw' };
  const capabilityId = 'get-member-savings-balance-discovered';

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'handsoff-discover-'));
    await cp(path.join(repoRoot, 'data/app-profiles'), path.join(dataDir, 'app-profiles'), {
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

  it('records a scripted run, compiles a valid capability, and never leaks the parameter value', async () => {
    const store = createFsStore(dataDir);
    const profile = await store.appProfiles.get('acme-coreteller');
    if (!profile) throw new Error('profile missing');
    const script = ScriptSchema.parse(
      JSON.parse(
        await readFile(
          path.join(repoRoot, 'data/discovery-scripts/get-member-savings-balance.json'),
          'utf8',
        ),
      ),
    );
    const surface = await createPlaywrightSurface({ headless: true });
    let result: Awaited<ReturnType<typeof discover>>;
    try {
      result = await discover(
        {
          goal: 'Look up member {memberId} and return the current balance of the Savings account',
          params: [
            {
              name: 'memberId',
              type: 'string',
              description: 'Member number as printed on the member card',
              sensitivity: 'sensitive',
              value: '10001',
            },
          ],
          capabilityId,
          name: 'Get member savings balance (discovered)',
          entryRoute: '/',
          baseUrl,
          outcomes: [{ code: 'MEMBER_NOT_FOUND', text: 'No matching member' }],
        },
        { surface, store, profile, planner: createScriptedPlanner(script), env },
      );
    } finally {
      await surface.close();
    }
    expect(result.status, JSON.stringify(result, null, 2)).toBe('compiled');
    if (result.status !== 'compiled') return;
    expect(result.stepsRecorded).toBe(3);

    const capability = await store.capabilities.get(capabilityId);
    expect(capability).toBeDefined();
    if (!capability) return;
    expect(capability.version).toBe(1);
    expect(capability.status).toBe('draft');
    expect(capability.steps.map((s) => s.action.kind)).toEqual(['type', 'click', 'click', 'extract']);
    expect(capability.steps.every((s) => s.target === undefined || s.target.strategies.length <= 3)).toBe(true);

    const s1 = capability.steps[0];
    expect(s1?.bindings).toContainEqual({ param: 'memberId', field: 'value', inferred: false });
    expect(s1?.target?.strategies[0]).toMatchObject({ kind: 'anchored', anchor: 'Member #', relation: 'labels' });
    expect(s1?.baseline).toEqual({ resolvedBy: 0, candidateCount: 1 });

    const s2 = capability.steps[1];
    expect(s2?.target?.strategies[0]).toMatchObject({ kind: 'role', role: 'button', name: 'Search' });
    expect(s2?.postcondition.when.textPresent).toEqual(['Search Results']);

    const s3 = capability.steps[2];
    expect(s3?.postcondition.when.url).toBe('/members/:memberId');
    expect(s3?.bindings).toContainEqual({ param: 'memberId', field: 'postcondition.url', inferred: true });

    const s4 = capability.steps[3];
    expect(s4?.target?.strategies[0]).toMatchObject({ kind: 'anchored', relation: 'same-row-column', anchor: 'Savings', column: 'Balance' });
    expect(capability.outputs[0]).toMatchObject({ name: 'savingsBalance', type: 'number', parser: 'currency', atStep: 's4', sensitivity: 'sensitive' });
    expect(capability.success.when.url).toBe('/members/:memberId');
    expect(capability.entry.preconditions[0]?.when.textPresent).toEqual(['Member Lookup']);
    expect(capability.detectors.map((d) => d.code)).toEqual(['MEMBER_NOT_FOUND']);

    // the recorded value must not appear anywhere persisted
    const artifact = JSON.stringify(capability);
    expect(artifact).not.toContain('10001');
    const events = await readFile(path.join(result.evidence.runDir, 'events.jsonl'), 'utf8');
    expect(events).not.toContain('10001');
    const transcript = await readFile(path.join(result.evidence.runDir, 'transcript.redacted.jsonl'), 'utf8');
    expect(transcript).not.toContain('10001');
    expect(transcript.trim().split('\n')).toHaveLength(4);
    await stat(path.join(result.evidence.runDir, 'result.json'));
  }, 120_000);

  it('replays the compiled capability deterministically, including the business outcome', async () => {
    const store = createFsStore(dataDir);
    const capability = await store.capabilities.get(capabilityId);
    const profile = await store.appProfiles.get('acme-coreteller');
    if (!capability || !profile) throw new Error('compiled capability missing');

    const run = async (memberId: string) => {
      const surface = await createPlaywrightSurface({ headless: true });
      try {
        return await replay({ capability, params: { memberId }, baseUrl }, { surface, store, profile, env });
      } finally {
        await surface.close();
      }
    };

    const ok = await run('10001');
    expect(ok.status, JSON.stringify(ok, null, 2)).toBe('success');
    if (ok.status === 'success') expect(ok.outputs).toEqual({ savingsBalance: 1250.75 });
    expect(ok.stepsRun.every((s) => !s.drift)).toBe(true);

    const missing = await run('99999');
    expect(missing.status, JSON.stringify(missing, null, 2)).toBe('outcome');
    if (missing.status === 'outcome') expect(missing.code).toBe('MEMBER_NOT_FOUND');
  }, 120_000);
});
