import { pathnameOf } from '../conditions/predicate.js';
import type { ParamValues, SurfaceObservation } from '../ports/surface.js';
import {
  type A11yNode,
  type Action,
  actionParams,
  type Baseline,
  type Binding,
  type Capability,
  CapabilitySchema,
  type Condition,
  type InputSpec,
  type OutputSpec,
  type Sensitivity,
  type Step,
  type SurfaceKind,
  type TargetSpec,
} from '../schema/index.js';
import { canonicalizePath, derivePostcondition, firstSalientText } from './derive-postcondition.js';
import { baselineOf, deriveTargetSpec } from './derive-target.js';

/** A step as discovery recorded it, with the observations around it. */
export interface DiscoveredStep {
  intent: string;
  /** Targets already replaced by TargetSpecs. */
  action: Action;
  target?: TargetSpec | undefined;
  baseline?: Baseline | undefined;
  before: SurfaceObservation;
  after: SurfaceObservation;
}

export interface DiscoveredOutput {
  name: string;
  /** The node the model pointed at when finishing; absent for literal outputs. */
  node?: A11yNode | undefined;
  raw: string;
}

export interface CompileInput {
  id: string;
  name: string;
  description: string;
  version: number;
  vendorProductId: string;
  surfaceKind: SurfaceKind;
  entryRoute: string;
  requiresAuth: boolean;
  inputs: InputSpec[];
  values: ParamValues;
  steps: DiscoveredStep[];
  outputs: DiscoveredOutput[];
  /** Observation at the moment the model finished. */
  finalObservation: SurfaceObservation;
  /** Observation at the first turn, before anything happened. */
  firstObservation: SurfaceObservation;
  outcomes: Array<{ code: string; text: string; message?: string | undefined }>;
  outputSensitivity: Sensitivity;
  provenance: {
    runId: string;
    model: string;
    effort?: string | undefined;
    recordedAt: string;
    variantId?: string | undefined;
    compiler: string;
  };
}

function inferOutput(raw: string): { type: OutputSpec['type']; parser?: OutputSpec['parser'] } {
  const t = raw.trim();
  if (/^\(?-?[$€£]\s?[\d,]+(\.\d+)?\)?$/.test(t)) return { type: 'number', parser: 'currency' };
  if (/^-?[\d,]+(\.\d+)?$/.test(t)) return { type: 'number' };
  if (/^\d{4}-\d{2}-\d{2}$/.test(t) || /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(t)) {
    return { type: 'date', parser: 'date' };
  }
  return { type: 'string' };
}

/**
 * Run → Capability, rule-based (D-021): prune, bind by provenance, derive targets with their
 * baseline, propose postconditions from observation deltas, turn finish outputs into extract
 * steps, and validate the result against the schema so an invalid artifact can never be written.
 */
export function compileCapability(input: CompileInput): Capability {
  const paramValues = Object.values(input.values);
  const steps: Step[] = [];
  const kept = input.steps.filter((s) => s.action.kind !== 'wait');

  kept.forEach((d, i) => {
    const id = `s${i + 1}`;
    const post = derivePostcondition(id, d.before, d.after, d.target, input.values);
    const bindings: Binding[] = [
      ...actionParams(d.action).map((u) => ({ param: u.param, field: u.field, inferred: false })),
      ...post.bindings,
    ];
    steps.push({
      id,
      intent: d.intent,
      action: d.action,
      ...(d.target ? { target: d.target } : {}),
      bindings,
      preconditions: [],
      postcondition: post.condition,
      risk: 'safe',
      confirm: 'none',
      baseline: d.baseline ?? { resolvedBy: 0, candidateCount: 1 },
      recordedBy: 'automation',
    });
  });

  const outputs: OutputSpec[] = [];
  for (const out of input.outputs) {
    if (!out.node) continue;
    const spec = deriveTargetSpec(out.node, input.finalObservation.nodes, paramValues);
    const id = `s${steps.length + 1}`;
    steps.push({
      id,
      intent: `Read ${out.name}`,
      action: { kind: 'extract', name: out.name, target: { spec } },
      target: spec,
      bindings: [],
      preconditions: [],
      postcondition: {
        id: `${id}-post`,
        role: 'postcondition',
        when: { element: spec, timeoutMs: 5_000 },
      },
      risk: 'safe',
      confirm: 'none',
      baseline: baselineOf(spec, input.finalObservation.nodes),
      recordedBy: 'automation',
    });
    const inferred = inferOutput(out.raw);
    outputs.push({
      name: out.name,
      type: inferred.type,
      ...(inferred.parser ? { parser: inferred.parser } : {}),
      description: `${out.name} as read from the page when the goal was achieved`,
      source: spec,
      atStep: id,
      required: true,
      sensitivity: input.outputSensitivity,
    });
  }

  const lastFlowStep = [...steps].reverse().find((s) => s.action.kind !== 'extract');
  const finalFrame = [...input.finalObservation.frames].sort(
    (a, b) => b.framePath.length - a.framePath.length,
  )[0];
  const { pattern } = canonicalizePath(
    pathnameOf(finalFrame?.url ?? input.finalObservation.url),
    input.values,
  );
  const successText = lastFlowStep?.postcondition.when.textPresent;
  const success: Condition = {
    id: 'success',
    role: 'postcondition',
    when: { url: pattern, ...(successText ? { textPresent: successText } : {}) },
  };

  const entryText = firstSalientText(input.firstObservation, input.values);
  const entryPreconditions: Condition[] = entryText
    ? [
        {
          id: 'entry-ready',
          role: 'precondition',
          when: { textPresent: [entryText], timeoutMs: 10_000 },
        },
      ]
    : [];

  const detectors: Condition[] = input.outcomes.map((o) => ({
    id: o.code.toLowerCase().replace(/_/g, '-'),
    role: 'detector',
    class: 'outcome',
    code: o.code,
    ...(o.message ? { message: o.message } : {}),
    when: { textPresent: [o.text] },
    terminal: true,
  }));

  const capability: Capability = {
    schemaVersion: 1,
    id: input.id,
    name: input.name,
    description: input.description,
    version: input.version,
    ...(input.version > 1 ? { supersedes: input.version - 1 } : {}),
    status: 'draft',
    provenance: {
      runId: input.provenance.runId,
      model: input.provenance.model,
      ...(input.provenance.effort ? { effort: input.provenance.effort } : {}),
      recordedAt: input.provenance.recordedAt,
      ...(input.provenance.variantId ? { variantId: input.provenance.variantId } : {}),
      compiler: input.provenance.compiler,
    },
    app: { vendorProductId: input.vendorProductId, surfaceKind: input.surfaceKind },
    entry: { route: input.entryRoute, requiresAuth: input.requiresAuth, preconditions: entryPreconditions },
    inputs: input.inputs,
    outputs,
    steps,
    success,
    detectors,
    policy: { requiredScopes: [], riskySteps: [] },
  };
  return CapabilitySchema.parse(capability);
}
