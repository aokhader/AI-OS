import type { Condition, FailureKind, RecoveryRoutine } from '../schema/index.js';
import { describePredicate, evaluatePredicate, type ObservationView } from './predicate.js';

/**
 * The one ordered classifier (D-014). Precedence, highest first:
 *   1. session-level detectors (rebootstrap recoveries): a sign-in page that also says "error"
 *      is a session expiry
 *   2. fatal detectors (fail-class error pages)
 *   3. known interstitials (dismiss and wait-retry recoveries)
 *   4. business outcomes, limited to their atSteps
 *   5. escalate-class detectors
 *   6. the step's postcondition
 * Budgets are enforced by the engine, which decides whether a `recover` is still allowed.
 */
export type Classification =
  | { kind: 'proceed' }
  | { kind: 'recover'; condition: Condition; routine: RecoveryRoutine }
  | { kind: 'outcome'; condition: Condition; code: string; message: string }
  | {
      kind: 'fail';
      failure: FailureKind;
      expected: string;
      observed: string;
      condition?: Condition;
    }
  | { kind: 'escalate'; condition: Condition };

export interface ClassifyInput {
  /** Step being executed; detectors with atSteps apply only when it matches. */
  stepId?: string | undefined;
  /** Profile detectors first, then capability detectors. */
  detectors: Condition[];
  /** The step's postcondition and whether it was met, if this classification follows an action. */
  postcondition?: { condition: Condition; met: boolean; detail: string } | undefined;
}

function applies(d: Condition, stepId: string | undefined): boolean {
  if (!d.atSteps) return true;
  return stepId !== undefined && d.atSteps.includes(stepId);
}

function rank(d: Condition): number {
  if (d.class === 'recover' && d.recovery?.kind === 'rebootstrap') return 0;
  if (d.class === 'fail') return 1;
  if (d.class === 'recover') return 2;
  if (d.class === 'outcome') return 3;
  if (d.class === 'escalate') return 4;
  return 5;
}

export function classify(obs: ObservationView, input: ClassifyInput): Classification {
  const matched = input.detectors
    .filter((d) => d.role === 'detector' && applies(d, input.stepId))
    .filter((d) => evaluatePredicate(d.when, obs).matched)
    .sort((a, b) => rank(a) - rank(b));

  const top = matched[0];
  if (top) {
    switch (top.class) {
      case 'fail':
        return {
          kind: 'fail',
          failure: (top.code as FailureKind | undefined) ?? 'UNEXPECTED_STATE',
          expected: input.postcondition
            ? describePredicate(input.postcondition.condition.when)
            : 'normal application state',
          observed: top.message ?? `condition ${top.id} matched`,
          condition: top,
        };
      case 'recover':
        if (top.recovery) return { kind: 'recover', condition: top, routine: top.recovery };
        break;
      case 'outcome':
        return {
          kind: 'outcome',
          condition: top,
          code: top.code ?? 'UNKNOWN_OUTCOME',
          message: top.message ?? `condition ${top.id} matched`,
        };
      case 'escalate':
        return { kind: 'escalate', condition: top };
      default:
        break;
    }
  }

  if (input.postcondition && !input.postcondition.met) {
    return {
      kind: 'fail',
      failure: 'CHECKPOINT_FAILED',
      expected: describePredicate(input.postcondition.condition.when),
      observed: input.postcondition.detail,
    };
  }
  return { kind: 'proceed' };
}
