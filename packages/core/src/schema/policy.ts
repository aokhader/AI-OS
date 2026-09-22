import { z } from 'zod';
import { ActionKindSchema } from './action.js';
import { RiskSchema } from './enums.js';

/** config/policy.json. Patterns in riskyPatterns are matched case-insensitively. */
export const PolicySchema = z.strictObject({
  allowedOrigins: z.array(z.url()).min(1),
  allowedRoutes: z.array(z.string().startsWith('/')).min(1),
  deniedRoutes: z.array(z.string().startsWith('/')),
  allowedActions: z.array(ActionKindSchema).min(1),
  riskyPatterns: z.strictObject({
    buttonText: z.array(z.string().min(1)),
    formAction: z.array(z.string().min(1)),
    routes: z.array(z.string().min(1)),
  }),
  riskyMode: z.strictObject({
    discovery: z.enum(['escalate', 'block']),
    replay: z.literal('require_approved'),
  }),
  escalationTimeoutMs: z.number().int().positive(),
  budgets: z.strictObject({
    recoveriesPerStep: z.number().int().nonnegative(),
    rebootstrapsPerRun: z.number().int().nonnegative(),
  }),
  assistedFallback: z.strictObject({
    enabled: z.boolean(),
    maxPerRun: z.number().int().nonnegative(),
  }),
});
export type Policy = z.infer<typeof PolicySchema>;

/** What the policy gate says about one action before it executes (D-015). */
export const VerdictSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('allow'), risk: RiskSchema }),
  z.strictObject({ kind: z.literal('block'), rule: z.string().min(1), reason: z.string().min(1) }),
  z.strictObject({
    kind: z.literal('confirm'),
    rule: z.string().min(1),
    reason: z.string().min(1),
  }),
]);
export type Verdict = z.infer<typeof VerdictSchema>;
