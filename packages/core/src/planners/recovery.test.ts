import { describe, expect, it } from 'vitest';
import type { Planner, PlannerTurn, RecoveryContext } from '../ports/planner.js';
import type { SurfaceObservation } from '../ports/surface.js';
import type { Decision, Step } from '../schema/index.js';
import {
  createRecoveryPlanner,
  createScriptedRecoveryPlanner,
  renderRecoveryGoal,
} from './recovery.js';

const observation: SurfaceObservation = {
  at: '2026-09-26T00:00:00.000Z',
  url: 'http://x/members',
  title: 'Member Lookup',
  frames: [{ framePath: ['main'], url: 'http://x/members', title: 'Member Lookup' }],
  nodes: [
    {
      ref: 'e7',
      role: 'button',
      name: 'Look up member',
      states: [],
      bbox: { x: 0, y: 0, w: 1, h: 1 },
      framePath: ['main'],
      path: 'form[1]/table[1]/tr[3]/td[1]/input[1]',
    },
  ],
  dialogs: [],
};

const step: Step = {
  id: 's2',
  intent: 'Click Search button',
  action: {
    kind: 'click',
    target: {
      spec: { strategies: [{ kind: 'role', role: 'button', name: 'Search' }], framePath: ['main'] },
    },
  },
  target: { strategies: [{ kind: 'role', role: 'button', name: 'Search' }], framePath: ['main'] },
  bindings: [],
  preconditions: [],
  postcondition: {
    id: 's2-post',
    role: 'postcondition',
    when: { textPresent: ['Search Results'] },
  },
  risk: 'safe',
  confirm: 'none',
  baseline: { resolvedBy: 0, candidateCount: 1 },
  recordedBy: 'automation',
};

const ctx: RecoveryContext = {
  observation,
  step,
  expected: 'button "Search"',
  observed: 'strategy 1: 0 candidate(s); nearest: button "Look up member"',
};

function plannerAnswering(decision: Decision, turns: PlannerTurn[] = []): Planner {
  return {
    info: () => ({ provider: 'test', model: 'test-model' }),
    transcript: () => [],
    decide: async (turn) => {
      turns.push(turn);
      return decision;
    },
  };
}

describe('assisted fallback on top of a Planner (D-038)', () => {
  it('asks for one action with the failed step, the expectation and what was seen', () => {
    const goal = renderRecoveryGoal(ctx);
    expect(goal).toContain('RECOVERY, one action only');
    expect(goal).toContain('s2');
    expect(goal).toContain('button "Search"');
    expect(goal).toContain('Look up member');
    expect(goal).toContain('give_up');
  });

  it('returns the proposed action and nothing else', async () => {
    const turns: PlannerTurn[] = [];
    const action = { kind: 'click' as const, target: { ref: 'e7' } };
    const planner = createRecoveryPlanner(
      plannerAnswering({ kind: 'tool', action, intent: 'the relabelled button' }, turns),
    );
    expect(await planner.proposeOne(ctx)).toEqual(action);
    expect(turns[0]).toMatchObject({ turn: 1, params: [], stepsRemaining: 1 });
    expect(turns[0]?.observation).toBe(observation);
    expect(planner.info().model).toBe('test-model');
  });

  it('turns give_up, finish and request_human into no proposal', async () => {
    for (const decision of [
      { kind: 'give_up' as const, reason: 'nothing fits' },
      { kind: 'finish' as const, outputs: {}, summary: 'done' },
      { kind: 'request_human' as const, reason: 'help' },
    ]) {
      const planner = createRecoveryPlanner(plannerAnswering(decision));
      expect(await planner.proposeOne(ctx)).toBeNull();
    }
  });

  it('a scripted recovery planner resolves its targets against the page it is shown', async () => {
    const planner = createScriptedRecoveryPlanner([
      {
        kind: 'click',
        intent: 'the relabelled button',
        target: {
          strategies: [{ kind: 'role', role: 'button', name: 'Look up member' }],
          framePath: ['main'],
        },
      },
    ]);
    expect(await planner.proposeOne(ctx)).toEqual({ kind: 'click', target: { ref: 'e7' } });
    expect(await planner.proposeOne(ctx)).toBeNull();
    expect(planner.transcript?.()).toHaveLength(2);
  });
});
