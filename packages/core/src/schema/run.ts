import { z } from 'zod';
import { ActionSchema, DecisionSchema } from './action.js';
import { BindingSchema, CapabilityRefSchema } from './capability.js';
import { IsoDateTimeSchema, KebabIdSchema, ParamNameSchema, RunIdSchema } from './common.js';
import { RecoveryRoutineSchema } from './condition.js';
import {
  ActorSchema,
  ConditionClassSchema,
  ConditionRoleSchema,
  ControlOwnerSchema,
  EscalationCauseSchema,
  FailureKindSchema,
  RiskSchema,
  SensitivitySchema,
  SideEffectsSchema,
} from './enums.js';
import { VerdictSchema } from './policy.js';
import { BaselineSchema, TargetSpecSchema } from './target.js';

export const RecoverySchema = z.strictObject({
  stepId: KebabIdSchema,
  conditionId: KebabIdSchema,
  routine: RecoveryRoutineSchema,
  attempt: z.number().int().positive(),
  outcome: z.enum(['recovered', 'exhausted', 'failed']),
  /** Assisted fallback only. */
  proposal: ActionSchema.optional(),
  at: IsoDateTimeSchema,
});
export type Recovery = z.infer<typeof RecoverySchema>;

export const StepReportSchema = z.strictObject({
  stepId: KebabIdSchema,
  attempts: z.number().int().positive(),
  durationMs: z.number().nonnegative(),
  resolvedBy: z.number().int().nonnegative().optional(),
  candidateCount: z.number().int().nonnegative().optional(),
  drift: z.boolean(),
});
export type StepReport = z.infer<typeof StepReportSchema>;

export const EvidenceRefSchema = z.strictObject({
  runDir: z.string().min(1),
  failingScreenshot: z.string().min(1).optional(),
  lastObservation: z.string().min(1).optional(),
});
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

/** A step as captured during a run, by automation or by a human (D-012). */
export const RecordedStepSchema = z.strictObject({
  id: KebabIdSchema,
  intent: z.string().min(1),
  action: ActionSchema,
  target: TargetSpecSchema.optional(),
  recordedBy: ActorSchema,
  observedBefore: z.string().min(1),
  observedAfter: z.string().min(1),
  resolvedBy: z.number().int().nonnegative(),
  candidateCount: z.number().int().nonnegative(),
  bindings: z.array(BindingSchema),
  risk: RiskSchema,
});
export type RecordedStep = z.infer<typeof RecordedStepSchema>;

/** The last escalation of the run and every human action recorded in it (D-036). */
export const EscalationBlockSchema = z.strictObject({
  id: z.string().min(1),
  cause: EscalationCauseSchema,
  humanActions: z.array(RecordedStepSchema),
  resolution: z.enum(['approved', 'resumed', 'completed_by_human', 'aborted', 'abandoned']),
  operatorId: z.string().min(1).optional(),
});
export type EscalationBlock = z.infer<typeof EscalationBlockSchema>;

const replayCommon = {
  capability: CapabilityRefSchema,
  variantId: KebabIdSchema.optional(),
  /** Where the run stopped, if not at the end. */
  atStep: KebabIdSchema.optional(),
  stepsRun: z.array(StepReportSchema),
  recoveries: z.array(RecoverySchema),
  sideEffects: SideEffectsSchema,
  escalation: EscalationBlockSchema.optional(),
  evidence: EvidenceRefSchema,
};

/**
 * Three terminal statuses. Business outcomes are answers, recoverables are events, escalation is
 * metadata (D-018).
 */
export const ReplayResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('success'),
    outputs: z.record(ParamNameSchema, z.unknown()),
    ...replayCommon,
  }),
  z.strictObject({
    status: z.literal('outcome'),
    code: z.string().min(1),
    message: z.string().min(1),
    data: z.unknown().optional(),
    ...replayCommon,
  }),
  z.strictObject({
    status: z.literal('failure'),
    kind: FailureKindSchema,
    expected: z.string().min(1),
    observed: z.string().min(1),
    ...replayCommon,
  }),
]);
export type ReplayResult = z.infer<typeof ReplayResultSchema>;

export const DiscoveryResultSchema = z.union([
  z.strictObject({
    status: z.literal('compiled'),
    capability: CapabilityRefSchema,
    stepsRecorded: z.number().int().nonnegative(),
    escalation: EscalationBlockSchema.optional(),
    evidence: EvidenceRefSchema,
  }),
  z.strictObject({
    status: z.enum(['gave_up', 'limit', 'aborted']),
    reason: z.string().min(1),
    stepsRecorded: z.number().int().nonnegative(),
    escalation: EscalationBlockSchema.optional(),
    evidence: EvidenceRefSchema,
  }),
]);
export type DiscoveryResult = z.infer<typeof DiscoveryResultSchema>;

export const RunSchema = z.strictObject({
  id: RunIdSchema,
  kind: z.enum(['discovery', 'replay']),
  /** Parameter values are never stored, only their types and sensitivity. */
  goal: z
    .strictObject({
      text: z.string().min(1),
      params: z.record(
        ParamNameSchema,
        z.strictObject({ type: z.string().min(1), sensitivity: SensitivitySchema }),
      ),
    })
    .optional(),
  capability: CapabilityRefSchema.optional(),
  target: z.strictObject({
    vendorProductId: KebabIdSchema,
    variantId: KebabIdSchema.optional(),
    entry: z.string().min(1),
  }),
  model: z.string().optional(),
  startedAt: IsoDateTimeSchema,
  finishedAt: IsoDateTimeSchema.optional(),
  controlOwner: ControlOwnerSchema,
  sideEffects: SideEffectsSchema,
});
export type Run = z.infer<typeof RunSchema>;

const eventBase = {
  at: IsoDateTimeSchema,
  runId: RunIdSchema,
  stepId: KebabIdSchema.optional(),
  actor: ActorSchema,
};

/** One line of events.jsonl. docs/context/01-architecture.md §13. */
export const RunEventSchema = z.discriminatedUnion('type', [
  z.strictObject({
    ...eventBase,
    type: z.literal('observation'),
    digest: z.string().min(1),
    url: z.string().optional(),
    title: z.string(),
    nodeCount: z.number().int().nonnegative(),
    dialogCount: z.number().int().nonnegative(),
    screenshot: z.string().optional(),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal('decision'),
    decision: z.union([
      DecisionSchema,
      z.strictObject({ kind: z.literal('resolve'), target: TargetSpecSchema }),
    ]),
    intent: z.string().optional(),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal('policy_check'),
    action: ActionSchema,
    verdict: VerdictSchema,
    liveRisk: RiskSchema,
    recordedRisk: RiskSchema.optional(),
    mismatch: z.boolean(),
  }),
  /** An operator's answer to a `confirm` verdict, or the absence of an operator (D-034). */
  z.strictObject({
    ...eventBase,
    type: z.literal('confirmation'),
    cause: EscalationCauseSchema,
    rule: z.string().min(1),
    reason: z.string().min(1),
    /** `handled`: the operator performed the step by hand and handed back with resume or mark_complete. */
    answer: z.enum(['approved', 'denied', 'unattended', 'handled']),
    operatorId: z.string().min(1).optional(),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal('action'),
    action: ActionSchema,
    resolvedBy: z.number().int().nonnegative().optional(),
    candidateCount: z.number().int().nonnegative().optional(),
    durationMs: z.number().nonnegative(),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal('condition'),
    conditionId: KebabIdSchema,
    role: ConditionRoleSchema,
    class: ConditionClassSchema.optional(),
    matched: z.boolean(),
    code: z.string().optional(),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal('recovery'),
    recovery: RecoverySchema,
    budgetRemaining: z.number().int().nonnegative(),
  }),
  /** The variant fingerprinted after bootstrap and the overrides applied for it (D-037). */
  z.strictObject({
    ...eventBase,
    type: z.literal('variant'),
    requested: KebabIdSchema.optional(),
    matched: z.array(KebabIdSchema),
    variantId: KebabIdSchema.optional(),
    overrides: z
      .strictObject({
        labels: z.number().int().nonnegative(),
        routes: z.number().int().nonnegative(),
        frames: z.number().int().nonnegative(),
        steps: z.number().int().nonnegative(),
        detectors: z.number().int().nonnegative(),
      })
      .optional(),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal('drift'),
    baseline: BaselineSchema,
    observed: BaselineSchema,
    fingerprintMismatch: z.boolean().optional(),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal('control_transfer'),
    from: ControlOwnerSchema,
    to: ControlOwnerSchema,
    operatorId: z.string().optional(),
    cause: EscalationCauseSchema.optional(),
    escalationId: z.string().min(1).optional(),
    /** Set on the transfer that ends an escalation. */
    handBack: z.enum(['approve_step', 'resume', 'mark_complete', 'abort', 'abandoned']).optional(),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal('human_action'),
    step: RecordedStepSchema,
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal('result'),
    result: z.union([ReplayResultSchema, DiscoveryResultSchema]),
  }),
]);
export type RunEvent = z.infer<typeof RunEventSchema>;
