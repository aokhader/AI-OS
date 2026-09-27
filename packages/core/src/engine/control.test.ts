import { describe, expect, it } from 'vitest';
import type { ControlOwner } from '../schema/index.js';
import {
  automationMayAct,
  type ControlEvent,
  ControlTransitionError,
  transition,
} from './control.js';

const OWNERS: ControlOwner[] = ['automation', 'awaiting_operator', 'human', 'aborted'];
const EVENTS: ControlEvent[] = [
  { type: 'escalate' },
  { type: 'claim' },
  { type: 'hand_back', to: 'automation' },
  { type: 'hand_back', to: 'aborted' },
  { type: 'abandon' },
];

describe('control-owner transitions (01 §11)', () => {
  it('follows the state diagram', () => {
    expect(transition('automation', { type: 'escalate' })).toBe('awaiting_operator');
    expect(transition('awaiting_operator', { type: 'claim' })).toBe('human');
    expect(transition('awaiting_operator', { type: 'abandon' })).toBe('aborted');
    expect(transition('awaiting_operator', { type: 'hand_back', to: 'aborted' })).toBe('aborted');
    expect(transition('human', { type: 'hand_back', to: 'automation' })).toBe('automation');
    expect(transition('human', { type: 'hand_back', to: 'aborted' })).toBe('aborted');
  });

  it('refuses everything the diagram does not draw', () => {
    const allowed = new Set([
      'automation:escalate',
      'awaiting_operator:claim',
      'awaiting_operator:abandon',
      'awaiting_operator:hand_back:aborted',
      'human:hand_back:automation',
      'human:hand_back:aborted',
    ]);
    for (const owner of OWNERS) {
      for (const event of EVENTS) {
        const key = `${owner}:${event.type}${event.type === 'hand_back' ? `:${event.to}` : ''}`;
        if (allowed.has(key)) continue;
        expect(() => transition(owner, event), key).toThrow(ControlTransitionError);
      }
    }
  });

  it('only resuming from a claim returns control to automation', () => {
    expect(() => transition('awaiting_operator', { type: 'hand_back', to: 'automation' })).toThrow(
      /cannot hand_back/,
    );
  });

  it('lets automation act only while it owns the session', () => {
    expect(automationMayAct('automation')).toBe(true);
    for (const owner of ['awaiting_operator', 'human', 'aborted'] as const) {
      expect(automationMayAct(owner)).toBe(false);
    }
  });
});
