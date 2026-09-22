import { z } from 'zod';

export const SensitivitySchema = z.enum(['public', 'internal', 'sensitive', 'secret']);
export type Sensitivity = z.infer<typeof SensitivitySchema>;

export const RiskSchema = z.enum(['safe', 'risky']);
export type Risk = z.infer<typeof RiskSchema>;

export const ConfirmSchema = z.enum(['none', 'operator']);
export type Confirm = z.infer<typeof ConfirmSchema>;

export const ActorSchema = z.enum(['automation', 'human']);
export type Actor = z.infer<typeof ActorSchema>;

export const ControlOwnerSchema = z.enum(['automation', 'awaiting_operator', 'human', 'aborted']);
export type ControlOwner = z.infer<typeof ControlOwnerSchema>;

export const SurfaceKindSchema = z.enum(['web', 'legacy-web', 'desktop-a11y']);
export type SurfaceKind = z.infer<typeof SurfaceKindSchema>;

export const ConditionRoleSchema = z.enum(['precondition', 'postcondition', 'detector']);
export type ConditionRole = z.infer<typeof ConditionRoleSchema>;

export const ConditionClassSchema = z.enum(['outcome', 'recover', 'fail', 'escalate']);
export type ConditionClass = z.infer<typeof ConditionClassSchema>;

export const FailureKindSchema = z.enum([
  'TARGET_NOT_FOUND',
  'CHECKPOINT_FAILED',
  'UNEXPECTED_STATE',
  'APP_ERROR',
  'TIMEOUT',
  'POLICY_BLOCKED',
  'DRIFT_SUSPECTED',
  'ESCALATION_ABANDONED',
]);
export type FailureKind = z.infer<typeof FailureKindSchema>;

export const EscalationCauseSchema = z.enum([
  'PLANNER_REQUESTED',
  'STUCK',
  'CONFIRM_REQUIRED',
  'CONDITION_ESCALATE',
  'RECOVERY_EXHAUSTED',
  'REPLAY_FAILURE',
]);
export type EscalationCause = z.infer<typeof EscalationCauseSchema>;

export const SideEffectsSchema = z.enum(['none', 'possible', 'committed']);
export type SideEffects = z.infer<typeof SideEffectsSchema>;

export const CapabilityStatusSchema = z.enum(['draft', 'approved', 'retired']);
export type CapabilityStatus = z.infer<typeof CapabilityStatusSchema>;
