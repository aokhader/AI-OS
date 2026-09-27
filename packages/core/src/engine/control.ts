import type { ControlOwner } from '../schema/index.js';

/**
 * The control-owner state machine (01 §11). A session has exactly one owner; automation acts
 * only while it is `automation`, and the check lives in the engine, not in the console.
 */
export type ControlEvent =
  | { type: 'escalate' }
  | { type: 'claim' }
  | { type: 'hand_back'; to: 'automation' | 'aborted' }
  | { type: 'abandon' };

export class ControlTransitionError extends Error {
  override readonly name = 'ControlTransitionError';
  constructor(
    readonly owner: ControlOwner,
    readonly event: ControlEvent,
  ) {
    super(`control owner ${owner} cannot ${event.type}`);
  }
}

const TRANSITIONS: Record<ControlOwner, Partial<Record<ControlEvent['type'], boolean>>> = {
  automation: { escalate: true },
  awaiting_operator: { claim: true, abandon: true, hand_back: true },
  human: { hand_back: true },
  aborted: {},
};

/** The owner after `event`, or a ControlTransitionError when the machine forbids it. */
export function transition(owner: ControlOwner, event: ControlEvent): ControlOwner {
  if (!TRANSITIONS[owner][event.type]) throw new ControlTransitionError(owner, event);
  switch (event.type) {
    case 'escalate':
      return 'awaiting_operator';
    case 'claim':
      return 'human';
    case 'abandon':
      return 'aborted';
    case 'hand_back':
      // Only abort may skip the claim: a person who resumes or completes has taken control.
      if (owner === 'awaiting_operator' && event.to === 'automation') {
        throw new ControlTransitionError(owner, event);
      }
      return event.to;
  }
}

/** True when the engine may call `surface.act`. */
export function automationMayAct(owner: ControlOwner): boolean {
  return owner === 'automation';
}
