import { cp, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type Capability,
  type ConsoleMessage,
  createFsStore,
  createScriptedPlanner,
  discover,
  type Escalation,
  type EscalationControls,
  type EscalationDetail,
  type EscalationListItem,
  type Operator,
  type Policy,
  PolicySchema,
  type ReplayResult,
  type RunEvent,
  replay,
  ScriptSchema,
} from '@handsoff/core';
import { createApp, variants } from '@handsoff/legacy-bank';
import { createPlaywrightSurface, type PlaywrightSurface } from '@handsoff/surface-playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi } from '../src/server/api.js';
import { createConsoleOperator, LiveRegistry } from '../src/server/live.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

/**
 * P6 exit criteria (04): automation pauses, a person completes a step in the browser, the
 * structured human actions are in the log, and the run finishes with an `escalation` block.
 * The person is played by Playwright acting on the live page while the control owner is
 * `human`, which is exactly what a hand in the headed window does to the DOM.
 */
describe('escalation and handoff', () => {
  let dataDir: string;
  let baseUrl: string;
  let policy: Policy;
  let close: () => Promise<void>;
  const env = { LEGACY_BANK_USER: 'teller', LEGACY_BANK_PASS: 'pw' };
  const subAccount = { memberId: '10001', accountType: 'Checking', deposit: '40.00' };

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'handsoff-escalation-'));
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

  async function stored(id: string): Promise<Capability> {
    const c = await createFsStore(dataDir).capabilities.get(id);
    if (!c) throw new Error(`${id} missing`);
    return c;
  }

  /** open-sub-account as a reviewer leaves it: approved, its submit risky with confirm operator. */
  async function confirmedSubmit(): Promise<Capability> {
    const c = await stored('open-sub-account');
    return {
      ...c,
      status: 'approved',
      steps: c.steps.map((s) => (s.id === 's7' ? { ...s, risk: 'risky', confirm: 'operator' } : s)),
      policy: { ...c.policy, riskySteps: ['s7'] },
    };
  }

  /** get-member-savings-balance with a Search button nobody can find: TARGET_NOT_FOUND at s2. */
  async function brokenSearch(): Promise<Capability> {
    const c = await stored('get-member-savings-balance');
    const target = {
      strategies: [{ kind: 'role' as const, role: 'button', name: 'Find' }],
      framePath: ['main'],
    };
    return {
      ...c,
      steps: c.steps.map((s) =>
        s.id === 's2' ? { ...s, target, action: { kind: 'click', target: { spec: target } } } : s,
      ),
    };
  }

  /** Waits for the next human action the engine records for this escalation. */
  function nextHumanAction(controls: EscalationControls, timeoutMs = 10_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error('no human action was recorded'));
      }, timeoutMs);
      const off = controls.onHumanAction(() => {
        clearTimeout(timer);
        off();
        resolve();
      });
    });
  }

  interface RunOptions {
    operator?: Operator | undefined;
    policy?: Policy | undefined;
    /** Gets the live surface so a test can play the person at the browser. */
    surfaceRef?: { current?: PlaywrightSurface } | undefined;
  }

  async function runReplay(
    capability: Capability,
    params: Record<string, string>,
    options: RunOptions = {},
  ): Promise<ReplayResult> {
    const store = createFsStore(dataDir);
    const profile = await store.appProfiles.get('acme-coreteller');
    if (!profile) throw new Error('profile missing');
    const surface = await createPlaywrightSurface({
      headless: true,
      allowedOrigins: policy.allowedOrigins,
    });
    if (options.surfaceRef) options.surfaceRef.current = surface;
    try {
      return await replay(
        { capability, params, baseUrl, policy: options.policy ?? policy, stepTimeoutMs: 8_000 },
        { surface, store, profile, env, operator: options.operator },
      );
    } finally {
      await surface.close();
    }
  }

  function mainFrame(surface: PlaywrightSurface) {
    const frame = surface.page.frame({ name: 'main' });
    if (!frame) throw new Error('main frame missing');
    return frame;
  }

  /** An operator that claims, lets the test act as the person, then hands back. */
  function person(
    surfaceRef: { current?: PlaywrightSurface },
    act: (surface: PlaywrightSurface, controls: EscalationControls) => Promise<void>,
    handBack: 'resume' | 'mark_complete',
    seen: Escalation[] = [],
  ): Operator {
    return {
      info: () => ({ id: 'tester' }),
      escalate: async (escalation, controls) => {
        seen.push(escalation);
        await controls.claim('tester');
        const surface = surfaceRef.current;
        if (!surface) throw new Error('no surface');
        await act(surface, controls);
        await controls.handBack(handBack, 'tester');
      },
    };
  }

  it('CONFIRM_REQUIRED: the person clicks the risky button, resumes, and automation finishes the flow', async () => {
    const surfaceRef: { current?: PlaywrightSurface } = {};
    const seen: Escalation[] = [];
    const operator = person(
      surfaceRef,
      async (surface, controls) => {
        const recorded = nextHumanAction(controls);
        await mainFrame(surface).getByRole('button', { name: 'Open Account' }).click();
        await recorded;
      },
      'resume',
      seen,
    );
    const result = await runReplay(await confirmedSubmit(), subAccount, { operator, surfaceRef });
    expect(result.status, JSON.stringify(result, null, 2)).toBe('success');
    if (result.status !== 'success') return;
    expect(result.outputs.confirmationNumber).toMatch(/^C-\d{6}$/);
    expect(result.sideEffects).toBe('committed');
    // the person's click satisfied s7 and left the confirmation page up, so s8's checkpoint holds
    // too: the scan continues at success and reads the output from that page
    expect(result.stepsRun.map((s) => s.stepId)).toEqual(['s1', 's2', 's3', 's4', 's5', 's6']);
    expect(result.escalation).toMatchObject({
      cause: 'CONFIRM_REQUIRED',
      resolution: 'resumed',
      operatorId: 'tester',
    });
    expect(result.escalation?.humanActions).toHaveLength(1);
    expect(result.escalation?.humanActions[0]).toMatchObject({
      id: 'h1',
      recordedBy: 'human',
      risk: 'risky',
      action: { kind: 'click' },
    });
    // derived from the observation like an automation step: role first, structural fallback last
    expect(result.escalation?.humanActions[0]?.target?.strategies[0]).toEqual({
      kind: 'role',
      role: 'button',
      name: 'Open Account',
    });
    expect(seen[0]).toMatchObject({
      phase: 'replay',
      cause: 'CONFIRM_REQUIRED',
      atStep: 's7',
      capability: { id: 'open-sub-account' },
      suggestedActions: ['approve_step', 'resume', 'mark_complete', 'abort'],
    });

    const all = await events(result.evidence.runDir);
    const transfers = all.filter((e) => e.type === 'control_transfer');
    expect(transfers.map((t) => [t.from, t.to, t.cause ?? t.handBack])).toEqual([
      ['automation', 'awaiting_operator', 'CONFIRM_REQUIRED'],
      ['awaiting_operator', 'human', undefined],
      ['human', 'automation', 'resume'],
    ]);
    expect(all.filter((e) => e.type === 'human_action')).toHaveLength(1);
    expect(all.find((e) => e.type === 'confirmation')).toMatchObject({ answer: 'handled' });
    await stat(path.join(result.evidence.runDir, 'escalation.json'));
    const record = await createFsStore(dataDir).escalations.get(result.escalation?.id ?? '');
    expect(record?.resolution).toMatchObject({ kind: 'resumed', by: 'tester', humanActions: 1 });
    const run = await createFsStore(dataDir).runs.get(path.basename(result.evidence.runDir));
    expect(run?.controlOwner).toBe('automation');
  }, 120_000);

  it('approve_step through the controls lets automation run the step itself', async () => {
    const operator: Operator = {
      info: () => ({ id: 'tester' }),
      escalate: (_e, controls) => controls.handBack('approve_step', 'tester'),
    };
    const result = await runReplay(await confirmedSubmit(), subAccount, { operator });
    expect(result.status, JSON.stringify(result, null, 2)).toBe('success');
    expect(result.escalation).toMatchObject({ resolution: 'approved', humanActions: [] });
    expect(result.stepsRun.map((s) => s.stepId)).toContain('s7');
  }, 120_000);

  it('abort ends the run before the step with nothing committed', async () => {
    const operator: Operator = {
      info: () => ({ id: 'tester' }),
      escalate: (_e, controls) => controls.handBack('abort', 'tester'),
    };
    const result = await runReplay(await confirmedSubmit(), subAccount, { operator });
    expect(result.status).toBe('failure');
    if (result.status !== 'failure') return;
    expect(result.kind).toBe('POLICY_BLOCKED');
    expect(result.atStep).toBe('s7');
    expect(result.sideEffects).toBe('none');
    expect(result.escalation).toMatchObject({ resolution: 'aborted', operatorId: 'tester' });
  }, 120_000);

  it('nobody claims within the timeout: ESCALATION_ABANDONED before the step', async () => {
    const silent: Operator = { info: () => ({ id: 'silent' }), escalate: () => undefined };
    const result = await runReplay(await confirmedSubmit(), subAccount, {
      operator: silent,
      policy: { ...policy, escalationTimeoutMs: 400 },
    });
    expect(result.status).toBe('failure');
    if (result.status !== 'failure') return;
    expect(result.kind).toBe('ESCALATION_ABANDONED');
    expect(result.observed).toContain('nobody claimed');
    expect(result.escalation).toMatchObject({ resolution: 'abandoned' });
    expect(result.sideEffects).toBe('none');
  }, 120_000);

  it('REPLAY_FAILURE: a target nobody can find is left to a person, who clicks it; the checkpoint scan continues after it', async () => {
    const surfaceRef: { current?: PlaywrightSurface } = {};
    const seen: Escalation[] = [];
    const operator = person(
      surfaceRef,
      async (surface, controls) => {
        const recorded = nextHumanAction(controls);
        await mainFrame(surface).getByRole('button', { name: 'Search' }).click();
        await recorded;
      },
      'resume',
      seen,
    );
    const result = await runReplay(
      await brokenSearch(),
      { memberId: '10001' },
      {
        operator,
        surfaceRef,
      },
    );
    expect(result.status, JSON.stringify(result, null, 2)).toBe('success');
    if (result.status !== 'success') return;
    expect(result.outputs).toEqual({ savingsBalance: 1250.75 });
    expect(seen[0]).toMatchObject({ cause: 'REPLAY_FAILURE', atStep: 's2' });
    expect(seen[0]?.detail).toContain('TARGET_NOT_FOUND');
    expect(result.escalation).toMatchObject({ cause: 'REPLAY_FAILURE', resolution: 'resumed' });
    expect(result.escalation?.humanActions[0]).toMatchObject({ recordedBy: 'human' });
    expect(result.escalation?.humanActions[0]?.target?.strategies[0]).toEqual({
      kind: 'role',
      role: 'button',
      name: 'Search',
    });
    expect(result.stepsRun.map((s) => s.stepId)).toEqual(['s1', 's3', 's4']);
    const all = await events(result.evidence.runDir);
    const scan = all.filter(
      (e) => e.type === 'condition' && e.role === 'postcondition' && e.stepId === 's2',
    );
    expect(scan.at(-1)).toMatchObject({ matched: true });
  }, 120_000);

  it('mark_complete: the person finishes the flow and automation reads the outputs from the page', async () => {
    const surfaceRef: { current?: PlaywrightSurface } = {};
    const operator = person(
      surfaceRef,
      async (surface, controls) => {
        const first = nextHumanAction(controls);
        await mainFrame(surface).getByRole('button', { name: 'Search' }).click();
        await first;
        const second = nextHumanAction(controls);
        await mainFrame(surface).getByRole('link', { name: 'View' }).click();
        await second;
      },
      'mark_complete',
    );
    const result = await runReplay(
      await brokenSearch(),
      { memberId: '10001' },
      {
        operator,
        surfaceRef,
      },
    );
    expect(result.status, JSON.stringify(result, null, 2)).toBe('success');
    if (result.status !== 'success') return;
    expect(result.outputs).toEqual({ savingsBalance: 1250.75 });
    expect(result.escalation).toMatchObject({ resolution: 'completed_by_human' });
    expect(result.escalation?.humanActions.map((h) => h.intent)).toEqual([
      'Operator clicked button "Search"',
      'Operator clicked link "View"',
    ]);
    expect(result.stepsRun.map((s) => s.stepId)).toEqual(['s1']);
  }, 120_000);

  it('unattended, a failure stays the failure it was classified as', async () => {
    const result = await runReplay(await brokenSearch(), { memberId: '10001' });
    expect(result.status).toBe('failure');
    if (result.status !== 'failure') return;
    expect(result.kind).toBe('TARGET_NOT_FOUND');
    expect(result.escalation).toBeUndefined();
  }, 120_000);

  it('discovery: the model asks for a person, who performs the steps; they compile as human steps', async () => {
    const store = createFsStore(dataDir);
    const profile = await store.appProfiles.get('acme-coreteller');
    if (!profile) throw new Error('profile missing');
    const script = ScriptSchema.parse([
      { kind: 'request_human', reason: 'I cannot tell which field is the member number' },
      {
        kind: 'finish',
        summary: 'The member detail page shows the Savings balance',
        outputs: {
          savingsBalance: {
            strategies: [
              {
                kind: 'anchored',
                anchor: 'Savings',
                relation: 'same-row-column',
                column: 'Balance',
              },
            ],
            framePath: ['main'],
          },
        },
      },
    ]);
    const surface = await createPlaywrightSurface({
      headless: true,
      allowedOrigins: policy.allowedOrigins,
    });
    const surfaceRef = { current: surface };
    const operator = person(
      surfaceRef,
      async (s, controls) => {
        const frame = mainFrame(s);
        const typed = nextHumanAction(controls);
        await frame.getByRole('textbox').fill('10001');
        await frame.getByRole('button', { name: 'Search' }).focus(); // blur commits the change
        await typed;
        const searched = nextHumanAction(controls);
        await frame.getByRole('button', { name: 'Search' }).click();
        await searched;
        const viewed = nextHumanAction(controls);
        await frame.getByRole('link', { name: 'View' }).click();
        await viewed;
      },
      'resume',
    );
    let result: Awaited<ReturnType<typeof discover>>;
    try {
      result = await discover(
        {
          goal: 'Look up member {memberId} and return the current balance of the Savings account',
          params: [
            {
              name: 'memberId',
              type: 'string',
              description: 'Member number',
              sensitivity: 'sensitive',
              value: '10001',
            },
          ],
          capabilityId: 'savings-balance-with-help',
          name: 'Savings balance (human-assisted discovery)',
          baseUrl,
          policy,
          outcomes: [{ code: 'MEMBER_NOT_FOUND', text: 'No matching member' }],
        },
        { surface, store, profile, planner: createScriptedPlanner(script), env, operator },
      );
    } finally {
      await surface.close();
    }
    expect(result.status, JSON.stringify(result, null, 2)).toBe('compiled');
    if (result.status !== 'compiled') return;
    expect(result.escalation).toMatchObject({ cause: 'PLANNER_REQUESTED', resolution: 'resumed' });
    expect(result.escalation?.humanActions).toHaveLength(3);
    const capability = await store.capabilities.get('savings-balance-with-help');
    expect(capability?.steps.map((s) => [s.id, s.action.kind, s.recordedBy])).toEqual([
      ['s1', 'type', 'human'],
      ['s2', 'click', 'human'],
      ['s3', 'click', 'human'],
      ['s4', 'extract', 'automation'],
    ]);
    // the value the person typed equals the parameter: recorded as the parameter, marked inferred
    expect(capability?.steps[0]?.action).toMatchObject({ value: { param: 'memberId' } });
    expect(capability?.steps[0]?.bindings).toContainEqual({
      param: 'memberId',
      field: 'value',
      inferred: true,
    });
    expect(JSON.stringify(capability)).not.toContain('10001');
    const eventsText = await readFile(path.join(result.evidence.runDir, 'events.jsonl'), 'utf8');
    expect(eventsText).not.toContain('10001');
    // and the compiled capability replays without anyone
    const again = await runReplay(capability as Capability, { memberId: '10001' });
    expect(again.status, JSON.stringify(again, null, 2)).toBe('success');
  }, 180_000);

  it('the live console API: list, claim, human action feed, hand back, WebSocket push', async () => {
    const registry = new LiveRegistry();
    const api = await createApi({ dataDir, live: registry });
    await api.listen({ port: 0, host: '127.0.0.1' });
    const port = (api.server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    const messages: ConsoleMessage[] = [];
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    socket.addEventListener('message', (m) => messages.push(JSON.parse(String(m.data))));
    await new Promise<void>((r) => socket.addEventListener('open', () => r()));
    try {
      const surfaceRef: { current?: PlaywrightSurface } = {};
      const running = runReplay(await confirmedSubmit(), subAccount, {
        operator: createConsoleOperator(registry),
        surfaceRef,
      });
      // the inbox shows the escalation as open and live
      let item: EscalationListItem | undefined;
      for (let i = 0; i < 100 && !item; i++) {
        const list = (await (
          await fetch(`${base}/api/escalations`)
        ).json()) as EscalationListItem[];
        item = list.find((e) => e.open && e.live);
        if (!item) await new Promise((r) => setTimeout(r, 200));
      }
      expect(item).toBeDefined();
      if (!item) return;
      const id = item.escalation.id;
      // claim over HTTP, act as the person, watch the feed, hand back over HTTP
      const claimed = await fetch(`${base}/api/escalations/${id}/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operatorId: 'console-tester' }),
      });
      expect(claimed.status).toBe(200);
      const surface = surfaceRef.current;
      if (!surface) throw new Error('no surface');
      await mainFrame(surface).getByRole('button', { name: 'Open Account' }).click();
      let detail: EscalationDetail | undefined;
      for (let i = 0; i < 50; i++) {
        detail = (await (await fetch(`${base}/api/escalations/${id}`)).json()) as EscalationDetail;
        if (detail.humanActions.length > 0) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(detail?.humanActions).toHaveLength(1);
      expect(detail?.escalation.claimedBy).toBe('console-tester');
      const handed = await fetch(`${base}/api/escalations/${id}/hand-back`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operatorId: 'console-tester', kind: 'resume' }),
      });
      expect(handed.status).toBe(200);
      const result = await running;
      expect(result.status, JSON.stringify(result, null, 2)).toBe('success');
      expect(result.escalation).toMatchObject({
        resolution: 'resumed',
        operatorId: 'console-tester',
      });
      // afterwards the record is closed and no longer live; a claim is refused
      const after = (await (
        await fetch(`${base}/api/escalations/${id}`)
      ).json()) as EscalationDetail;
      expect(after.open).toBe(false);
      expect(after.live).toBe(false);
      expect(after.humanActions).toHaveLength(1);
      const refused = await fetch(`${base}/api/escalations/${id}/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operatorId: 'x' }),
      });
      expect(refused.status).toBe(409);
      await new Promise((r) => setTimeout(r, 200));
      expect(messages.map((m) => m.type)).toEqual(
        expect.arrayContaining(['escalation', 'human_action', 'run']),
      );
    } finally {
      socket.close();
      await api.close();
    }
  }, 120_000);
});
