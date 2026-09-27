import { evaluatePredicate, type ObservationView } from '../conditions/predicate.js';
import type { Condition } from '../schema/index.js';

export interface CheckpointCheck {
  stepId: string;
  matched: boolean;
  detail: string;
}

export interface CheckpointScan {
  /** Index of the step to run next. */
  resumeAt: number;
  /** Steps whose postcondition holds on the page, in order. */
  satisfied: string[];
  checks: CheckpointCheck[];
}

/**
 * "Where did the human leave the flow?" (01 §11): evaluate the postconditions of the current step
 * and every following step against one observation and resume after the last one that holds. No
 * step before `fromIndex` is considered, since those already ran. When none holds, the current
 * step runs again.
 */
export function scanCheckpoints(
  steps: ReadonlyArray<{ id: string; postcondition: Condition }>,
  obs: ObservationView,
  fromIndex: number,
): CheckpointScan {
  const checks: CheckpointCheck[] = [];
  const satisfied: string[] = [];
  let resumeAt = Math.max(0, fromIndex);
  for (let i = resumeAt; i < steps.length; i++) {
    const step = steps[i];
    if (!step) break;
    const r = evaluatePredicate(step.postcondition.when, obs);
    checks.push({ stepId: step.id, matched: r.matched, detail: r.detail });
    if (r.matched) {
      satisfied.push(step.id);
      resumeAt = i + 1;
    }
  }
  return { resumeAt, satisfied, checks };
}
