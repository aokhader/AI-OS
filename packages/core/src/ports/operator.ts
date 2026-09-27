import type { Escalation, HandBackKind, RecordedStep } from '../schema/index.js';

export interface OperatorInfo {
  /** Free-text operator id in the demo; an authenticated identity at real scale. */
  id: string;
}

/**
 * What the engine hands the operator with an escalation (01 §11, D-036). Claiming moves the
 * control owner to `human` and starts recording what the person does in the browser; handing
 * back moves it away again and resolves the engine's wait.
 */
export interface EscalationControls {
  /** Take control. Idempotent for the same operator; a second operator is refused. */
  claim(operatorId: string): Promise<void>;
  /**
   * Give control back. `abort` needs no claim; the other kinds claim first when nobody has.
   * Resolves once the engine has recorded the transfer.
   */
  handBack(kind: HandBackKind, operatorId: string): Promise<void>;
  /** The record as it stands now (claim and resolution included). */
  current(): Escalation;
  /** Human actions recorded so far in this escalation, redacted. */
  humanActions(): RecordedStep[];
  /** Subscribe to human actions as they are recorded; returns the unsubscribe function. */
  onHumanAction(listener: (step: RecordedStep) => void): () => void;
  /** Resolves when the escalation ends, however it ends. */
  settled: Promise<Escalation>;
}

/**
 * The human side of every escalation cause. The CLI answers from the terminal, the console over
 * the runner's live API. With no operator attached the engine resolves the escalation
 * `abandoned` at once: replay stops before the step, discovery tells the model to find another
 * route.
 */
export interface Operator {
  info(): OperatorInfo;
  /**
   * Called once per escalation, after the record is written. Implementations answer through the
   * controls, now or later; the engine waits for the hand-back or the abandonment timeout.
   */
  escalate(escalation: Escalation, controls: EscalationControls): void | Promise<void>;
}
