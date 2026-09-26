import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ObservationView } from '../conditions/predicate.js';
import {
  type A11yNode,
  type Action,
  ConditionSchema,
  type Policy,
  PolicySchema,
} from '../schema/index.js';
import {
  checkPolicy,
  classifyRisk,
  type GateInput,
  permissivePolicy,
  RUNTIME_DETECTORS,
} from './gate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');
const policy: Policy = PolicySchema.parse(
  JSON.parse(readFileSync(path.join(repoRoot, 'config/policy.json'), 'utf8')),
);
const baseUrl = 'http://localhost:4100';

function node(role: string, name: string, extra: Partial<A11yNode> = {}): A11yNode {
  return {
    ref: 'e1',
    role,
    name,
    states: [],
    bbox: { x: 0, y: 0, w: 10, h: 10 },
    framePath: ['main'],
    path: 'form[1]/input[1]',
    ...extra,
  };
}

function page(url = `${baseUrl}/members/10001`): ObservationView {
  return {
    url,
    title: 'CoreTeller',
    frames: [{ framePath: ['main'], url, title: '' }],
    nodes: [],
    dialogs: [],
  };
}

const click: Action = { kind: 'click', target: { ref: 'e1' } };

function input(partial: Partial<GateInput> & Pick<GateInput, 'action'>): GateInput {
  return { observation: page(), phase: 'discovery', baseUrl, values: {}, ...partial };
}

describe('checkPolicy: allowlists', () => {
  it('allows a plain click on a safe control', () => {
    const r = checkPolicy(policy, input({ action: click, node: node('button', 'Search') }));
    expect(r).toEqual({
      verdict: { kind: 'allow', risk: 'safe' },
      liveRisk: 'safe',
      mismatch: false,
    });
  });

  it('blocks an action kind that is not allowed', () => {
    const p = { ...policy, allowedActions: policy.allowedActions.filter((a) => a !== 'press') };
    const r = checkPolicy(p, input({ action: { kind: 'press', key: 'Enter' } }));
    expect(r.verdict).toMatchObject({ kind: 'block', rule: 'allowedActions' });
  });

  it('blocks a navigation to an origin outside the allowlist', () => {
    const r = checkPolicy(
      policy,
      input({ action: { kind: 'navigate', url: { text: 'https://example.com/' } } }),
    );
    expect(r.verdict).toMatchObject({ kind: 'block', rule: 'allowedOrigins' });
    expect(r.verdict.kind === 'block' && r.verdict.reason).toContain('https://example.com');
  });

  it('blocks a denied route before checking allowed routes', () => {
    const r = checkPolicy(
      policy,
      input({ action: { kind: 'navigate', url: { text: '/admin/users' } } }),
    );
    expect(r.verdict).toMatchObject({ kind: 'block', rule: 'deniedRoutes' });
  });

  it('blocks a route that matches no allowed route', () => {
    const r = checkPolicy(
      policy,
      input({ action: { kind: 'navigate', url: { text: '/reports/daily' } } }),
    );
    expect(r.verdict).toMatchObject({ kind: 'block', rule: 'allowedRoutes' });
  });

  it('allows a navigation on the allowlist, resolving parameters first', () => {
    const r = checkPolicy(
      policy,
      input({
        action: { kind: 'navigate', url: { param: 'route' } },
        values: { route: '/members/10001' },
      }),
    );
    expect(r.verdict).toEqual({ kind: 'allow', risk: 'safe' });
  });

  it('blocks a navigation whose URL cannot be resolved', () => {
    const r = checkPolicy(policy, input({ action: { kind: 'navigate', url: { param: 'route' } } }));
    expect(r.verdict).toMatchObject({ kind: 'block', rule: 'allowedOrigins' });
  });
});

describe('classifyRisk: live classification (D-015)', () => {
  it('matches button text case-insensitively', () => {
    const r = classifyRisk(policy, input({ action: click, node: node('button', 'OPEN ACCOUNT') }));
    expect(r?.rule).toBe('riskyPatterns.buttonText[6]');
  });

  it('matches the enclosing form action', () => {
    const r = classifyRisk(
      policy,
      input({
        action: click,
        node: node('button', 'OK', { formAction: `${baseUrl}/members/10001/accounts/open` }),
      }),
    );
    expect(r?.rule).toBe('riskyPatterns.formAction[0]');
  });

  it('matches the current route for a click or a key press', () => {
    const obs = page(`${baseUrl}/members/10001/accounts/2/close`);
    expect(
      classifyRisk(policy, input({ action: click, node: node('button', 'OK'), observation: obs }))
        ?.rule,
    ).toBe('riskyPatterns.routes[0]');
    expect(
      classifyRisk(policy, input({ action: { kind: 'press', key: 'Enter' }, observation: obs }))
        ?.rule,
    ).toBe('riskyPatterns.routes[0]');
  });

  it('matches the target route of a navigation', () => {
    const r = classifyRisk(
      policy,
      input({ action: { kind: 'navigate', url: { text: '/members/1/accounts/2/close' } } }),
    );
    expect(r?.rule).toBe('riskyPatterns.routes[0]');
  });

  it('never classifies typing, selecting or extracting as risky', () => {
    const risky = node('textbox', 'Transfer amount', {
      formAction: `${baseUrl}/members/1/accounts/open`,
    });
    expect(
      classifyRisk(
        policy,
        input({
          action: { kind: 'type', target: { ref: 'e1' }, value: { text: 'x' } },
          node: risky,
        }),
      ),
    ).toBeUndefined();
    expect(
      classifyRisk(
        policy,
        input({
          action: { kind: 'select', target: { ref: 'e1' }, value: { text: 'x' } },
          node: risky,
        }),
      ),
    ).toBeUndefined();
    expect(
      classifyRisk(
        policy,
        input({ action: { kind: 'extract', name: 'x', target: { ref: 'e1' } }, node: risky }),
      ),
    ).toBeUndefined();
  });

  it('treats an invalid regular expression as literal text', () => {
    const p = { ...policy, riskyPatterns: { ...policy.riskyPatterns, buttonText: ['close ('] } };
    expect(
      classifyRisk(p, input({ action: click, node: node('button', 'Close (all)') })),
    ).toBeDefined();
  });
});

describe('checkPolicy at discovery', () => {
  const submit = node('button', 'Open Account');

  it('asks for confirmation on a risky action under riskyMode.discovery escalate', () => {
    const r = checkPolicy(policy, input({ action: click, node: submit }));
    expect(r.verdict).toMatchObject({ kind: 'confirm', rule: 'riskyPatterns.buttonText[6]' });
    expect(r.liveRisk).toBe('risky');
  });

  it('blocks a risky action under riskyMode.discovery block', () => {
    const p = { ...policy, riskyMode: { ...policy.riskyMode, discovery: 'block' as const } };
    const r = checkPolicy(p, input({ action: click, node: submit }));
    expect(r.verdict).toMatchObject({ kind: 'block', rule: 'riskyPatterns.buttonText[6]' });
  });
});

describe('checkPolicy at replay (D-034)', () => {
  const submit = node('button', 'Open Account');
  const replay = (recorded: GateInput['recorded'], n: A11yNode = submit) =>
    checkPolicy(policy, input({ action: click, node: n, phase: 'replay', recorded }));

  it('a step recorded safe that is risky live needs an operator, approved or not', () => {
    for (const approved of [true, false]) {
      const r = replay({ risk: 'safe', confirm: 'none', approved });
      expect(r.mismatch).toBe(true);
      expect(r.liveRisk).toBe('risky');
      expect(r.verdict).toMatchObject({ kind: 'confirm', rule: 'riskyPatterns.buttonText[6]' });
      expect(r.verdict.kind === 'confirm' && r.verdict.reason).toContain('recorded safe');
    }
  });

  it('a recorded risky step on an unapproved capability is blocked', () => {
    const r = replay({ risk: 'risky', confirm: 'none', approved: false });
    expect(r.verdict).toMatchObject({ kind: 'block', rule: 'riskyMode.replay' });
    expect(r.mismatch).toBe(false);
  });

  it('an approved risky step with confirm none is allowed as risky', () => {
    const r = replay({ risk: 'risky', confirm: 'none', approved: true });
    expect(r.verdict).toEqual({ kind: 'allow', risk: 'risky' });
  });

  it('an approved risky step with confirm operator asks every time', () => {
    const r = replay({ risk: 'risky', confirm: 'operator', approved: true });
    expect(r.verdict).toMatchObject({ kind: 'confirm' });
    expect(r.verdict.kind === 'confirm' && r.verdict.reason).toContain('operator confirmation');
  });

  it('a recorded risky step that looks safe live is still risky, with a mismatch', () => {
    const r = replay(
      { risk: 'risky', confirm: 'none', approved: true },
      node('button', 'Continue'),
    );
    expect(r.mismatch).toBe(true);
    expect(r.liveRisk).toBe('safe');
    expect(r.verdict).toEqual({ kind: 'allow', risk: 'risky' });
  });

  it('a safe step stays safe without a mismatch', () => {
    const r = replay({ risk: 'safe', confirm: 'none', approved: false }, node('button', 'Search'));
    expect(r).toEqual({
      verdict: { kind: 'allow', risk: 'safe' },
      liveRisk: 'safe',
      mismatch: false,
    });
  });
});

describe('defaults and runtime detectors', () => {
  it('permissivePolicy locks the origin and nothing else', () => {
    const p = permissivePolicy('http://localhost:4102/some/path');
    expect(p.allowedOrigins).toEqual(['http://localhost:4102']);
    expect(PolicySchema.safeParse(p).success).toBe(true);
    const r = checkPolicy(
      p,
      input({
        action: { kind: 'navigate', url: { text: '/anything/at/all' } },
        baseUrl: 'http://localhost:4102',
      }),
    );
    expect(r.verdict).toEqual({ kind: 'allow', risk: 'safe' });
    expect(
      checkPolicy(
        p,
        input({
          action: click,
          node: node('button', 'Open Account'),
          baseUrl: 'http://localhost:4102',
        }),
      ).liveRisk,
    ).toBe('safe');
  });

  it('the blocked-navigation detector is a valid fail detector', () => {
    for (const d of RUNTIME_DETECTORS) expect(ConditionSchema.safeParse(d).success).toBe(true);
    expect(RUNTIME_DETECTORS[0]).toMatchObject({ class: 'fail', code: 'POLICY_BLOCKED' });
  });
});
