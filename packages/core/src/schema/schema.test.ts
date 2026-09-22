import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AppProfileSchema,
  CapabilitySchema,
  ConditionSchema,
  PolicySchema,
  ReplayResultSchema,
  TargetSpecSchema,
} from './index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');
const fixtures = path.resolve(here, '../../test/fixtures');

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function issues(result: { success: boolean; error?: { issues: unknown[] } }): string {
  return result.success ? '' : JSON.stringify(result.error?.issues, null, 2);
}

const exampleCapability = readJson(
  path.join(fixtures, 'capability.get-member-savings-balance.v1.json'),
) as Record<string, unknown>;

describe('CapabilitySchema', () => {
  it('accepts the example artifact', () => {
    const r = CapabilitySchema.safeParse(exampleCapability);
    expect(r.success, issues(r)).toBe(true);
  });

  it('rejects a semver version string', () => {
    const c = clone(exampleCapability);
    c.version = '1.0.0';
    expect(CapabilitySchema.safeParse(c).success).toBe(false);
  });

  it('rejects a supersedes that is not earlier', () => {
    const c = clone(exampleCapability);
    c.version = 2;
    c.supersedes = 2;
    expect(CapabilitySchema.safeParse(c).success).toBe(false);
  });

  it('rejects unknown top-level keys', () => {
    const c = clone(exampleCapability);
    c.notes = 'hand-edited';
    expect(CapabilitySchema.safeParse(c).success).toBe(false);
  });

  it('rejects a step postcondition with the wrong role', () => {
    const c = clone(exampleCapability) as { steps: Array<{ postcondition: { role: string } }> };
    c.steps[0]!.postcondition.role = 'detector';
    expect(CapabilitySchema.safeParse(c).success).toBe(false);
  });

  it('rejects a binding to an undeclared input', () => {
    const c = clone(exampleCapability) as {
      steps: Array<{ action: { value?: { param: string } }; bindings: Array<{ param: string }> }>;
    };
    c.steps[0]!.action.value = { param: 'accountId' };
    c.steps[0]!.bindings[0]!.param = 'accountId';
    expect(CapabilitySchema.safeParse(c).success).toBe(false);
  });

  it('rejects an action that uses a param without a binding', () => {
    const c = clone(exampleCapability) as { steps: Array<{ bindings: unknown[] }> };
    c.steps[0]!.bindings = [];
    expect(CapabilitySchema.safeParse(c).success).toBe(false);
  });

  it('rejects an uncompiled live ref as a step target', () => {
    const c = clone(exampleCapability) as { steps: Array<{ action: { target: unknown } }> };
    c.steps[1]!.action.target = { ref: 'e12' };
    expect(CapabilitySchema.safeParse(c).success).toBe(false);
  });

  it('rejects an output that points at an unknown step', () => {
    const c = clone(exampleCapability) as { outputs: Array<{ atStep: string }> };
    c.outputs[0]!.atStep = 's9';
    expect(CapabilitySchema.safeParse(c).success).toBe(false);
  });

  it('requires risky steps to be listed in policy.riskySteps', () => {
    const c = clone(exampleCapability) as {
      steps: Array<{ risk: string }>;
      policy: { riskySteps: string[] };
    };
    c.steps[1]!.risk = 'risky';
    expect(CapabilitySchema.safeParse(c).success).toBe(false);
    c.policy.riskySteps = ['s2'];
    const r = CapabilitySchema.safeParse(c);
    expect(r.success, issues(r)).toBe(true);
  });

  it('rejects a variant override for an unknown step', () => {
    const c = clone(exampleCapability) as {
      variants: Record<string, { steps: Record<string, unknown> }>;
    };
    c.variants['sample-federal-cu']!.steps.s7 = c.variants['sample-federal-cu']!.steps.s3;
    expect(CapabilitySchema.safeParse(c).success).toBe(false);
  });
});

describe('ConditionSchema', () => {
  const base = { id: 'x', when: { textPresent: ['Hello'] } };

  it('accepts each role', () => {
    expect(ConditionSchema.safeParse({ ...base, role: 'precondition' }).success).toBe(true);
    expect(ConditionSchema.safeParse({ ...base, role: 'postcondition' }).success).toBe(true);
    expect(
      ConditionSchema.safeParse({ ...base, role: 'detector', class: 'outcome', code: 'NOT_FOUND' })
        .success,
    ).toBe(true);
  });

  it('rejects a detector without a class', () => {
    expect(ConditionSchema.safeParse({ ...base, role: 'detector' }).success).toBe(false);
  });

  it('rejects an outcome detector without a code', () => {
    expect(ConditionSchema.safeParse({ ...base, role: 'detector', class: 'outcome' }).success).toBe(
      false,
    );
  });

  it('rejects a fail detector whose code is not a FailureKind', () => {
    expect(
      ConditionSchema.safeParse({ ...base, role: 'detector', class: 'fail', code: 'BOOM' }).success,
    ).toBe(false);
    expect(
      ConditionSchema.safeParse({ ...base, role: 'detector', class: 'fail', code: 'APP_ERROR' })
        .success,
    ).toBe(true);
  });

  it('rejects a recover detector without a routine', () => {
    expect(ConditionSchema.safeParse({ ...base, role: 'detector', class: 'recover' }).success).toBe(
      false,
    );
    expect(
      ConditionSchema.safeParse({
        ...base,
        role: 'detector',
        class: 'recover',
        recovery: { kind: 'rebootstrap' },
      }).success,
    ).toBe(true);
  });

  it('rejects class or recovery on a precondition', () => {
    expect(
      ConditionSchema.safeParse({ ...base, role: 'precondition', class: 'outcome' }).success,
    ).toBe(false);
  });

  it('rejects an empty predicate', () => {
    expect(ConditionSchema.safeParse({ id: 'x', role: 'precondition', when: {} }).success).toBe(
      false,
    );
    expect(
      ConditionSchema.safeParse({ id: 'x', role: 'precondition', when: { timeoutMs: 5 } }).success,
    ).toBe(false);
  });
});

describe('TargetSpecSchema', () => {
  it('requires a column for same-row-column', () => {
    expect(
      TargetSpecSchema.safeParse({
        strategies: [{ kind: 'anchored', anchor: 'Savings', relation: 'same-row-column' }],
        framePath: [],
      }).success,
    ).toBe(false);
  });

  it('allows at most three strategies', () => {
    const s = { kind: 'structural', path: 'table[1]' };
    expect(TargetSpecSchema.safeParse({ strategies: [s, s, s, s], framePath: [] }).success).toBe(
      false,
    );
    expect(TargetSpecSchema.safeParse({ strategies: [s], framePath: ['main'] }).success).toBe(true);
  });
});

describe('AppProfileSchema', () => {
  it('accepts data/app-profiles/acme-coreteller.json', () => {
    const r = AppProfileSchema.safeParse(
      readJson(path.join(repoRoot, 'data/app-profiles/acme-coreteller.json')),
    );
    expect(r.success, issues(r)).toBe(true);
  });

  it('rejects a bootstrap step that uses an undeclared credential', () => {
    const p = readJson(path.join(repoRoot, 'data/app-profiles/acme-coreteller.json')) as {
      bootstrap: { credentials: Record<string, unknown> };
    };
    delete p.bootstrap.credentials.password;
    expect(AppProfileSchema.safeParse(p).success).toBe(false);
  });
});

describe('PolicySchema', () => {
  it('accepts config/policy.json', () => {
    const r = PolicySchema.safeParse(readJson(path.join(repoRoot, 'config/policy.json')));
    expect(r.success, issues(r)).toBe(true);
  });
});

describe('ReplayResultSchema', () => {
  const common = {
    capability: { id: 'get-member-savings-balance', version: 1 },
    stepsRun: [
      {
        stepId: 's1',
        attempts: 1,
        durationMs: 120,
        resolvedBy: 0,
        candidateCount: 1,
        drift: false,
      },
    ],
    recoveries: [],
    sideEffects: 'none',
    evidence: { runDir: 'data/runs/run_20260924_150000_0000' },
  };

  it('accepts success, outcome and failure', () => {
    expect(
      ReplayResultSchema.safeParse({
        status: 'success',
        outputs: { savingsBalance: 1250.75 },
        ...common,
      }).success,
    ).toBe(true);
    expect(
      ReplayResultSchema.safeParse({
        status: 'outcome',
        code: 'MEMBER_NOT_FOUND',
        message: 'No member matches',
        atStep: 's2',
        ...common,
      }).success,
    ).toBe(true);
    expect(
      ReplayResultSchema.safeParse({
        status: 'failure',
        kind: 'CHECKPOINT_FAILED',
        expected: 'Search Results',
        observed: 'Member Lookup',
        atStep: 's2',
        ...common,
      }).success,
    ).toBe(true);
  });

  it('rejects escalated as a status', () => {
    expect(
      ReplayResultSchema.safeParse({ status: 'escalated', escalationId: 'e1', ...common }).success,
    ).toBe(false);
  });

  it('carries escalation as metadata on a terminal status', () => {
    const r = ReplayResultSchema.safeParse({
      status: 'success',
      outputs: {},
      ...common,
      escalation: { id: 'esc_1', humanActions: [], resolution: 'completed_by_human' },
    });
    expect(r.success, issues(r)).toBe(true);
  });
});
