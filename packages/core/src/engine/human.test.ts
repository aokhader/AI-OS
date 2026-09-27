import { describe, expect, it } from 'vitest';
import type { HumanAction, SurfaceObservation } from '../ports/surface.js';
import type { A11yNode } from '../schema/index.js';
import { RecordedStepSchema } from '../schema/index.js';
import { actionFromHuman, describeHumanAction, humanStep, nodeForHuman } from './human.js';

function node(
  ref: string,
  role: string,
  name: string,
  path: string,
  extra: Partial<A11yNode> = {},
): A11yNode {
  return {
    ref,
    role,
    name,
    states: [],
    bbox: { x: 0, y: 0, w: 10, h: 10 },
    framePath: ['main'],
    path,
    ...extra,
  };
}

const before: SurfaceObservation = {
  at: '2026-09-26T00:00:00.000Z',
  url: 'http://x/members/10001/accounts/open',
  title: 'Open',
  frames: [{ framePath: ['main'], url: 'http://x/members/10001/accounts/open', title: 'Open' }],
  nodes: [
    node('e1', 'cell', 'Account type', 'form[1]/table[1]/tr[1]/td[1]'),
    node('e2', 'combobox', 'Account type', 'form[1]/table[1]/tr[1]/td[2]/select[1]', {
      value: '-- select --',
    }),
    node('e3', 'button', 'Open Account', 'form[1]/table[1]/tr[3]/td[2]/input[1]'),
  ],
  dialogs: [],
};
const after: SurfaceObservation = {
  ...before,
  url: 'http://x/members/10001/confirmation/C-1',
  nodes: [],
};

const click: HumanAction = {
  kind: 'click',
  at: '2026-09-26T00:00:01.000Z',
  framePath: ['main'],
  url: before.url,
  path: 'form[1]/table[1]/tr[3]/td[2]/input[1]',
  role: 'button',
  name: 'Open Account',
};

describe('human actions as steps (D-036)', () => {
  it('finds the element the person acted on in the last observation', () => {
    expect(nodeForHuman(click, before)?.ref).toBe('e3');
    expect(nodeForHuman({ ...click, framePath: ['nav'] }, before)).toBeUndefined();
  });

  it('derives the target like an automation step and records the actor', () => {
    const { step, target, baseline } = humanStep({
      id: 'h1',
      action: click,
      before,
      after,
      paramValues: ['10001'],
      risk: 'risky',
    });
    expect(RecordedStepSchema.safeParse(step).success).toBe(true);
    expect(step.recordedBy).toBe('human');
    expect(step.risk).toBe('risky');
    expect(step.intent).toBe('Operator clicked button "Open Account"');
    expect(target.strategies[0]).toEqual({ kind: 'role', role: 'button', name: 'Open Account' });
    expect(baseline).toEqual({ resolvedBy: 0, candidateCount: 1 });
    expect(step.observedBefore).not.toBe(step.observedAfter);
  });

  it('falls back to a structural target when the element appeared after the last observation', () => {
    const { step, target } = humanStep({
      id: 'h2',
      action: { ...click, path: 'div[3]/button[1]', name: 'Later' },
      before,
      after,
      paramValues: [],
      risk: 'safe',
    });
    expect(target.strategies).toEqual([{ kind: 'structural', path: 'div[3] > button[1]' }]);
    expect(step.resolvedBy).toBe(0);
  });

  it('maps changes to select or type and Enter submits to a key press', () => {
    const spec = { strategies: [], framePath: ['main'] };
    expect(
      actionFromHuman({ ...click, kind: 'change', role: 'combobox', value: 'Checking' }, spec),
    ).toEqual({ kind: 'select', target: { spec }, value: { text: 'Checking' } });
    expect(
      actionFromHuman({ ...click, kind: 'change', role: 'textbox', value: '25.00' }, spec),
    ).toEqual({ kind: 'type', target: { spec }, value: { text: '25.00' }, clear: true });
    expect(actionFromHuman({ ...click, kind: 'change', role: 'checkbox' }, spec)).toEqual({
      kind: 'click',
      target: { spec },
    });
    expect(actionFromHuman({ ...click, kind: 'submit', role: 'form' }, spec)).toEqual({
      kind: 'press',
      key: 'Enter',
    });
    expect(describeHumanAction({ ...click, kind: 'submit', role: 'form', name: '' })).toBe(
      'Operator submitted the form with Enter',
    );
  });
});
