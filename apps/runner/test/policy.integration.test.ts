import { cp, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type Capability,
  createFsStore,
  createScriptedPlanner,
  discover,
  type Operator,
  type Policy,
  PolicySchema,
  type RunEvent,
  replay,
  ScriptSchema,
} from '@handsoff/core';
import { createApp, variants } from '@handsoff/legacy-bank';
import { createPlaywrightSurface } from '@handsoff/surface-playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

/**
 * P5 exit criteria (04): an off-allowlist navigation is blocked at both layers with evidence, the
 * risky submit of open-sub-account asks for CONFIRM_REQUIRED, and nothing under the run folder
 * shows a raw sensitive value. Real headless Chromium, in-process mock app, no model.
 */
describe('policy gate and redaction', () => {
  let dataDir: string;
  let baseUrl: string;
  let policy: Policy;
  let close: () => Promise<void>;
  const env = { LEGACY_BANK_USER: 'teller', LEGACY_BANK_PASS: 'pw' };
  const subAccount = { memberId: '10001', accountType: 'Checking', deposit: '40.00' };

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'handsoff-policy-'));
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
    policy = { ...fromRepo, allowedOrigins: [baseUrl] };
  });

  afterAll(async () => {
    await close();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function events(runDir: string): Promise<RunEvent[]> {
    const text = await readFile(path.join(runDir, 'events.jsonl'), 'utf8');
    return text
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as RunEvent);
  }

  /** Every text file under the run folder, concatenated. */
  async function persistedText(runDir: string): Promise<string> {
    const parts: string[] = [];
    const walk = async (dir: string) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(p);
        else if (/\.(json|jsonl)$/.test(entry.name)) parts.push(await readFile(p, 'utf8'));
      }
    };
    await walk(runDir);
    return parts.join('\n');
  }

  async function runReplay(
    capability: Capability,
    params: Record<string, string>,
    options: { operator?: Operator | undefined; chaos?: string | undefined } = {},
  ) {
    const store = createFsStore(dataDir);
    const profile = await store.appProfiles.get('acme-coreteller');
    if (!profile) throw new Error('profile missing');
    const surface = await createPlaywrightSurface({
      headless: true,
      allowedOrigins: policy.allowedOrigins,
      ...(options.chaos ? { extraHTTPHeaders: { 'x-handsoff-chaos': options.chaos } } : {}),
    });
    try {
      return await replay(
        { capability, params, baseUrl, policy, stepTimeoutMs: 8_000 },
        { surface, store, profile, env, operator: options.operator },
      );
    } finally {
      await surface.close();
    }
  }

  const operator = (answer: 'approved' | 'denied'): Operator => ({
    info: () => ({ id: `test:${answer}` }),
    confirm: async () => answer,
  });

  it('blocks off-allowlist navigations at the gate and a clicked external link at the network layer', async () => {
    const store = createFsStore(dataDir);
    const profile = await store.appProfiles.get('acme-coreteller');
    if (!profile) throw new Error('profile missing');
    const script = ScriptSchema.parse(
      JSON.parse(
        await readFile(path.join(repoRoot, 'data/discovery-scripts/policy-blocked.json'), 'utf8'),
      ),
    );
    const surface = await createPlaywrightSurface({
      headless: true,
      allowedOrigins: policy.allowedOrigins,
    });
    let result: Awaited<ReturnType<typeof discover>>;
    try {
      result = await discover(
        {
          goal: 'Find the vendor support portal',
          params: [],
          capabilityId: 'policy-blocked-probe',
          name: 'Policy probe',
          baseUrl,
          policy,
        },
        { surface, store, profile, planner: createScriptedPlanner(script), env },
      );
    } finally {
      await surface.close();
    }
    expect(result.status, JSON.stringify(result, null, 2)).toBe('aborted');
    if (result.status !== 'aborted') return;
    expect(result.reason).toContain('POLICY_BLOCKED');
    expect(result.stepsRecorded).toBe(0);
    await stat(path.join(result.evidence.runDir, result.evidence.failingScreenshot ?? ''));
    await stat(path.join(result.evidence.runDir, result.evidence.lastObservation ?? ''));

    const checks = (await events(result.evidence.runDir)).filter(
      (e): e is Extract<RunEvent, { type: 'policy_check' }> => e.type === 'policy_check',
    );
    const blocked = checks.filter((c) => c.verdict.kind === 'block');
    expect(blocked.map((c) => (c.verdict.kind === 'block' ? c.verdict.rule : ''))).toEqual([
      'deniedRoutes',
      'allowedOrigins',
    ]);
    // the click on the footer link passed the gate (a link's href is not in the a11y snapshot)
    // and was answered by the surface with the block page
    const snapshot = await readFile(
      path.join(result.evidence.runDir, result.evidence.lastObservation ?? ''),
      'utf8',
    );
    expect(snapshot).toContain('Navigation blocked by policy');
    expect(snapshot).toContain('support.example.com');
  }, 120_000);

  it('answers a direct navigation outside the allowlist with NAVIGATION_BLOCKED', async () => {
    const surface = await createPlaywrightSurface({
      headless: true,
      allowedOrigins: policy.allowedOrigins,
    });
    try {
      const r = await surface.act(
        { kind: 'navigate', url: { text: 'https://blocked.example.invalid/anything' } },
        { actor: 'automation', values: {}, baseUrl },
      );
      expect(r).toMatchObject({ ok: false, reason: 'NAVIGATION_BLOCKED' });
      const obs = await surface.observe({ screenshot: false });
      expect(obs.nodes.some((n) => n.name.includes('Navigation blocked by policy'))).toBe(true);
      const ok = await surface.act(
        { kind: 'navigate', url: { text: '/login' } },
        { actor: 'automation', values: {}, baseUrl },
      );
      expect(ok.ok).toBe(true);
    } finally {
      await surface.close();
    }
  }, 60_000);

  it('paints over nodes the engine marks sensitive before the screenshot is taken', async () => {
    const surface = await createPlaywrightSurface({ headless: true });
    try {
      await surface.page.setContent(
        '<form><label>Member # <input value="10001"></label><p>Balance 1,250.75</p></form>',
      );
      const plain = await surface.observe();
      const field = plain.nodes.find((n) => n.role === 'textbox');
      if (!field || !plain.screenshotPng) throw new Error('no textbox observed');
      const masked = await surface.observe({ mask: (n) => n.value === '10001' });
      if (!masked.screenshotPng) throw new Error('no screenshot');
      const centre = {
        x: Math.round(field.bbox.x + field.bbox.w / 2),
        y: Math.round(field.bbox.y + field.bbox.h / 2),
      };
      const pixel = async (png: Uint8Array) =>
        surface.page.evaluate(
          async ({ b64, x, y }) => {
            const img = new Image();
            img.src = `data:image/png;base64,${b64}`;
            await img.decode();
            const c = document.createElement('canvas');
            c.width = img.width;
            c.height = img.height;
            const ctx = c.getContext('2d');
            if (!ctx) throw new Error('no canvas');
            ctx.drawImage(img, 0, 0);
            const d = ctx.getImageData(x, y, 1, 1).data;
            return [d[0], d[1], d[2]];
          },
          { b64: Buffer.from(png).toString('base64'), ...centre },
        );
      expect(await pixel(masked.screenshotPng)).toEqual([17, 17, 17]);
      expect(await pixel(plain.screenshotPng)).not.toEqual([17, 17, 17]);
      // the overlay is gone again: the next snapshot sees the same nodes
      const after = await surface.observe({ screenshot: false });
      expect(after.nodes.map((n) => n.ref)).toEqual(plain.nodes.map((n) => n.ref));
    } finally {
      await surface.close();
    }
  }, 60_000);

  it('persists no raw sensitive value: hashed placeholders in events and result.json, values in-process', async () => {
    const store = createFsStore(dataDir);
    const capability = await store.capabilities.get('get-member-savings-balance');
    if (!capability) throw new Error('capability missing');
    const result = await runReplay(capability, { memberId: '10001' });
    expect(result.status, JSON.stringify(result, null, 2)).toBe('success');
    if (result.status !== 'success') return;
    expect(result.outputs).toEqual({ savingsBalance: 1250.75 });

    const text = await persistedText(result.evidence.runDir);
    expect(text).not.toContain('10001');
    expect(text).not.toContain('1250.75');
    const persisted = JSON.parse(
      await readFile(path.join(result.evidence.runDir, 'result.json'), 'utf8'),
    ) as { outputs: Record<string, unknown> };
    expect(persisted.outputs.savingsBalance).toMatch(/^«savingsBalance#sha256:[0-9a-f]{12}»$/);
    const typed = (await events(result.evidence.runDir)).find(
      (e) => e.type === 'action' && e.stepId === 's1' && e.action.kind === 'type',
    );
    expect(JSON.stringify(typed)).toContain('"param":"memberId"');
  }, 90_000);

  describe('the risky submit of open-sub-account (D-034)', () => {
    async function stored(): Promise<Capability> {
      const c = await createFsStore(dataDir).capabilities.get('open-sub-account');
      if (!c) throw new Error('open-sub-account missing');
      return c;
    }

    /** The artifact as a reviewer would leave it after discovery classified s7 risky. */
    function riskySubmit(
      c: Capability,
      status: Capability['status'],
      confirm: 'none' | 'operator',
    ): Capability {
      return {
        ...c,
        status,
        steps: c.steps.map((s) => (s.id === 's7' ? { ...s, risk: 'risky', confirm } : s)),
        policy: { ...c.policy, riskySteps: ['s7'] },
      };
    }

    it('a submit recorded safe is a mismatch that needs an operator; unattended, the run ends before it', async () => {
      // an artifact from before the gate existed, or whose button was relabelled since: s7 recorded safe
      const c = await stored();
      const stale: Capability = {
        ...c,
        status: 'approved',
        steps: c.steps.map((s) => (s.id === 's7' ? { ...s, risk: 'safe', confirm: 'none' } : s)),
        policy: { ...c.policy, riskySteps: [] },
      };
      const result = await runReplay(stale, subAccount);
      expect(result.status, JSON.stringify(result, null, 2)).toBe('failure');
      if (result.status !== 'failure') return;
      expect(result.kind).toBe('ESCALATION_ABANDONED');
      expect(result.atStep).toBe('s7');
      expect(result.expected).toContain('CONFIRM_REQUIRED');
      expect(result.sideEffects).toBe('none');
      expect(result.stepsRun.map((s) => s.stepId)).toEqual(['s1', 's2', 's3', 's4', 's5', 's6']);
      const all = await events(result.evidence.runDir);
      const check = all.find((e) => e.type === 'policy_check' && e.stepId === 's7');
      expect(check).toMatchObject({
        verdict: { kind: 'confirm', rule: 'riskyPatterns.buttonText[6]' },
        liveRisk: 'risky',
        recordedRisk: 'safe',
        mismatch: true,
      });
      expect(all.find((e) => e.type === 'confirmation')).toMatchObject({
        cause: 'CONFIRM_REQUIRED',
        answer: 'unattended',
      });
    }, 120_000);

    it('a recorded risky step on a draft capability is blocked', async () => {
      const result = await runReplay(riskySubmit(await stored(), 'draft', 'none'), subAccount);
      expect(result.status, JSON.stringify(result, null, 2)).toBe('failure');
      if (result.status !== 'failure') return;
      expect(result.kind).toBe('POLICY_BLOCKED');
      expect(result.atStep).toBe('s7');
      expect(result.observed).toContain('not approved');
      expect(result.sideEffects).toBe('none');
    }, 120_000);

    it('approved with confirm none replays unattended and commits', async () => {
      const result = await runReplay(riskySubmit(await stored(), 'approved', 'none'), subAccount);
      expect(result.status, JSON.stringify(result, null, 2)).toBe('success');
      if (result.status !== 'success') return;
      expect(result.outputs.confirmationNumber).toMatch(/^C-\d{6}$/);
      expect(result.sideEffects).toBe('committed');
      const check = (await events(result.evidence.runDir)).find(
        (e) => e.type === 'policy_check' && e.stepId === 's7',
      );
      expect(check).toMatchObject({ verdict: { kind: 'allow', risk: 'risky' }, mismatch: false });
    }, 120_000);

    it('approved with confirm operator asks, and an approval lets the step run', async () => {
      const result = await runReplay(
        riskySubmit(await stored(), 'approved', 'operator'),
        subAccount,
        {
          operator: operator('approved'),
        },
      );
      expect(result.status, JSON.stringify(result, null, 2)).toBe('success');
      if (result.status !== 'success') return;
      expect(result.sideEffects).toBe('committed');
      expect(
        (await events(result.evidence.runDir)).find((e) => e.type === 'confirmation'),
      ).toMatchObject({
        cause: 'CONFIRM_REQUIRED',
        answer: 'approved',
        operatorId: 'test:approved',
        actor: 'human',
      });
    }, 120_000);

    it('a denial stops the run before the step with nothing committed', async () => {
      const result = await runReplay(
        riskySubmit(await stored(), 'approved', 'operator'),
        subAccount,
        {
          operator: operator('denied'),
        },
      );
      expect(result.status, JSON.stringify(result, null, 2)).toBe('failure');
      if (result.status !== 'failure') return;
      expect(result.kind).toBe('POLICY_BLOCKED');
      expect(result.atStep).toBe('s7');
      expect(result.observed).toContain('denied');
      expect(result.sideEffects).toBe('none');
    }, 120_000);
  });

  it('discovery classifies the submit live and compiles it risky with confirm operator', async () => {
    const store = createFsStore(dataDir);
    const profile = await store.appProfiles.get('acme-coreteller');
    if (!profile) throw new Error('profile missing');
    const script = ScriptSchema.parse(
      JSON.parse(
        await readFile(path.join(repoRoot, 'data/discovery-scripts/open-sub-account.json'), 'utf8'),
      ),
    );
    const approvals: string[] = [];
    const attended: Operator = {
      info: () => ({ id: 'test:attended' }),
      confirm: async (req) => {
        approvals.push(`${req.stepId}:${req.rule}`);
        return 'approved';
      },
    };
    const surface = await createPlaywrightSurface({
      headless: true,
      allowedOrigins: policy.allowedOrigins,
    });
    let result: Awaited<ReturnType<typeof discover>>;
    try {
      result = await discover(
        {
          goal: 'Open a new {accountType} sub-account for member {memberId} with an initial deposit of {deposit}',
          params: [
            {
              name: 'memberId',
              type: 'string',
              description: 'Member number',
              sensitivity: 'sensitive',
              value: '10001',
            },
            {
              name: 'accountType',
              type: 'string',
              description: 'Type of sub-account',
              sensitivity: 'internal',
              value: 'Checking',
            },
            {
              name: 'deposit',
              type: 'string',
              description: 'Initial deposit',
              sensitivity: 'internal',
              value: '25.00',
            },
          ],
          capabilityId: 'open-sub-account-scripted',
          name: 'Open sub-account (scripted)',
          baseUrl,
          policy,
          outcomes: [{ code: 'VALIDATION_REJECTED', text: 'Please correct the errors below.' }],
        },
        {
          surface,
          store,
          profile,
          planner: createScriptedPlanner(script),
          env,
          operator: attended,
        },
      );
    } finally {
      await surface.close();
    }
    expect(result.status, JSON.stringify(result, null, 2)).toBe('compiled');
    if (result.status !== 'compiled') return;
    expect(approvals).toEqual(['t7:riskyPatterns.buttonText[6]']);
    const capability = await store.capabilities.get('open-sub-account-scripted');
    expect(capability?.steps.map((s) => [s.id, s.risk, s.confirm])).toEqual([
      ['s1', 'safe', 'none'],
      ['s2', 'safe', 'none'],
      ['s3', 'safe', 'none'],
      ['s4', 'safe', 'none'],
      ['s5', 'safe', 'none'],
      ['s6', 'safe', 'none'],
      ['s7', 'risky', 'operator'],
      ['s8', 'safe', 'none'],
    ]);
    expect(capability?.policy.riskySteps).toEqual(['s7']);
    const all = await events(result.evidence.runDir);
    expect(all.find((e) => e.type === 'confirmation')).toMatchObject({
      stepId: 't7',
      answer: 'approved',
      operatorId: 'test:attended',
    });
    const text = await persistedText(result.evidence.runDir);
    expect(text).not.toContain('10001');
  }, 120_000);
});
