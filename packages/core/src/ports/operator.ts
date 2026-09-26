import type { Action, EscalationCause } from '../schema/index.js';

/** What an operator is asked before a risky action executes (01 §11, D-034). */
export interface ConfirmRequest {
  runId: string;
  phase: 'discovery' | 'replay';
  stepId: string;
  intent: string;
  action: Action;
  /** Redacted description of the element the action targets, e.g. `button "Open Account"`. */
  target?: string | undefined;
  cause: EscalationCause;
  /** The policy rule that produced the verdict and why. */
  rule: string;
  reason: string;
  /** Latest masked screenshot, relative to the run folder. */
  screenshot?: string | undefined;
}

export type ConfirmAnswer = 'approved' | 'denied';

export interface OperatorInfo {
  /** Free-text operator id in the demo; an authenticated identity at real scale. */
  id: string;
}

/**
 * The human side of a `confirm` verdict. The CLI answers from the terminal; P6's console inbox
 * answers over the escalation record. When no operator is attached, replay stops before the step
 * with `ESCALATION_ABANDONED` and discovery tells the model to pick another route.
 */
export interface Operator {
  info(): OperatorInfo;
  confirm(request: ConfirmRequest): Promise<ConfirmAnswer>;
}
