import { z } from 'zod';
import { IsoDateTimeSchema, KebabIdSchema, RunIdSchema } from './common.js';
import { ControlOwnerSchema, EscalationCauseSchema } from './enums.js';

/** The intervention request an operator sees, and the record of what they did (§11). */
export const EscalationSchema = z.strictObject({
  id: z.string().min(1),
  runId: RunIdSchema,
  cause: EscalationCauseSchema,
  detail: z.string().min(1),
  atStep: KebabIdSchema.optional(),
  stepIntent: z.string().optional(),
  /** Masked screenshot path. */
  screenshot: z.string().min(1),
  snapshotDigest: z.string().min(1),
  suggestedActions: z.array(z.enum(['approve_step', 'resume', 'mark_complete', 'abort'])).min(1),
  requestedAt: IsoDateTimeSchema,
  /** Free-text operator id in the demo; an authenticated identity at real scale. */
  claimedBy: z.string().min(1).optional(),
  claimedAt: IsoDateTimeSchema.optional(),
  resolution: z
    .strictObject({
      kind: z.enum(['resumed', 'completed_by_human', 'aborted', 'abandoned']),
      at: IsoDateTimeSchema,
      resumedAtStep: KebabIdSchema.optional(),
    })
    .optional(),
});
export type Escalation = z.infer<typeof EscalationSchema>;

export const SessionStateSchema = z.strictObject({
  runId: RunIdSchema,
  controlOwner: ControlOwnerSchema,
  operatorId: z.string().min(1).optional(),
  since: IsoDateTimeSchema,
});
export type SessionState = z.infer<typeof SessionStateSchema>;
