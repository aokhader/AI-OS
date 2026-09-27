import { baselineOf, deriveTargetSpec } from '../compile/derive-target.js';
import { digestOf } from '../digest.js';
import type { HumanAction, SurfaceObservation } from '../ports/surface.js';
import type {
  A11yNode,
  Action,
  Baseline,
  RecordedStep,
  Risk,
  TargetSpec,
} from '../schema/index.js';

/** The core action a human event stands for; undefined for events that are not actions. */
export function actionFromHuman(a: HumanAction, target: TargetSpec): Action | undefined {
  switch (a.kind) {
    case 'click':
      return { kind: 'click', target: { spec: target } };
    case 'change':
      if (a.role === 'combobox') {
        return { kind: 'select', target: { spec: target }, value: { text: a.value ?? '' } };
      }
      if (a.role === 'checkbox' || a.role === 'radio') {
        return { kind: 'click', target: { spec: target } };
      }
      return {
        kind: 'type',
        target: { spec: target },
        value: { text: a.value ?? '' },
        clear: true,
      };
    case 'submit':
      return { kind: 'press', key: 'Enter' };
  }
}

export function describeHumanAction(a: HumanAction): string {
  const what = a.name ? `${a.role} "${a.name}"` : a.role;
  switch (a.kind) {
    case 'click':
      return `Operator clicked ${what}`;
    case 'change':
      return `Operator changed ${what}`;
    case 'submit':
      return `Operator submitted the form with Enter`;
  }
}

/** The node of the last observation the human acted on, matched by frame and structural path. */
export function nodeForHuman(a: HumanAction, before: SurfaceObservation): A11yNode | undefined {
  return before.nodes.find(
    (n) => n.path === a.path && n.framePath.join('/') === a.framePath.join('/'),
  );
}

export interface HumanStepInput {
  id: string;
  action: HumanAction;
  /** The observation the person acted on. */
  before: SurfaceObservation;
  /** The observation once the page settled after the action. */
  after: SurfaceObservation;
  paramValues: string[];
  risk: Risk;
}

/**
 * A person's action as a first-class step (01 §11, D-036): the TargetSpec is derived from the
 * element in the last observation the same way automation steps are, with a structural fallback
 * when the element was not in it (a control that appeared after the last observation).
 */
export function humanStep(input: HumanStepInput): {
  step: RecordedStep;
  target: TargetSpec;
  baseline: Baseline;
} {
  const { action: a, before, after, paramValues } = input;
  const node = nodeForHuman(a, before);
  const target: TargetSpec = node
    ? deriveTargetSpec(node, before.nodes, paramValues)
    : {
        strategies: [{ kind: 'structural', path: a.path.split('/').join(' > ') }],
        framePath: a.framePath,
      };
  const baseline: Baseline = node
    ? baselineOf(target, before.nodes)
    : { resolvedBy: 0, candidateCount: 1 };
  const action = actionFromHuman(a, target) ?? { kind: 'press', key: 'Enter' };
  const targeted = action.kind !== 'press';
  const step: RecordedStep = {
    id: input.id,
    intent: describeHumanAction(a),
    action,
    ...(targeted ? { target } : {}),
    recordedBy: 'human',
    observedBefore: digestOf(before),
    observedAfter: digestOf(after),
    resolvedBy: baseline.resolvedBy,
    candidateCount: baseline.candidateCount,
    bindings: [],
    risk: input.risk,
  };
  return { step, target, baseline };
}
