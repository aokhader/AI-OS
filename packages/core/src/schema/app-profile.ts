import { z } from 'zod';
import { BootstrapStepSchema } from './capability.js';
import { KebabIdSchema, ParamNameSchema, RoutePathSchema } from './common.js';
import { ConditionSchema } from './condition.js';
import { SurfaceKindSchema } from './enums.js';

export const FingerprintSchema = z
  .strictObject({
    titleIncludes: z.string().min(1).optional(),
    textPresent: z.array(z.string().min(1)).min(1).optional(),
    versionBanner: z.string().min(1).optional(),
    urlPattern: z.string().min(1).optional(),
  })
  .superRefine((f, ctx) => {
    if (!f.titleIncludes && !f.textPresent && !f.versionBanner && !f.urlPattern) {
      ctx.addIssue({ code: 'custom', message: 'a fingerprint must test at least one thing' });
    }
  });
export type Fingerprint = z.infer<typeof FingerprintSchema>;

/** Product-wide overrides for one variant. Capability-specific step overrides live on the capability. */
export const ProfileVariantOverridesSchema = z.strictObject({
  /** Applied to role.name and anchored.anchor / column. */
  labels: z.record(z.string().min(1), z.string().min(1)).optional(),
  routes: z.record(z.string().min(1), z.string().min(1)).optional(),
  detectors: z.array(ConditionSchema).optional(),
});
export type ProfileVariantOverrides = z.infer<typeof ProfileVariantOverridesSchema>;

export const VariantSchema = z.strictObject({
  name: z.string().min(1),
  fingerprint: FingerprintSchema,
  overrides: ProfileVariantOverridesSchema,
});
export type Variant = z.infer<typeof VariantSchema>;

/**
 * The login routine. Credentials are referenced by environment variable name; the steps use
 * `{ param }` values that the engine binds from those variables. Values are never logged.
 */
export const BootstrapRoutineSchema = z
  .strictObject({
    entry: RoutePathSchema,
    credentials: z.record(ParamNameSchema, z.strictObject({ env: z.string().min(1) })),
    steps: z.array(BootstrapStepSchema).min(1),
    success: ConditionSchema,
  })
  .superRefine((b, ctx) => {
    if (b.success.role !== 'postcondition') {
      ctx.addIssue({
        code: 'custom',
        message: 'bootstrap success must have role postcondition',
        path: ['success', 'role'],
      });
    }
    b.steps.forEach((s, i) => {
      const value =
        s.action.kind === 'type' || s.action.kind === 'select' ? s.action.value : undefined;
      if (value && 'param' in value && !(value.param in b.credentials)) {
        ctx.addIssue({
          code: 'custom',
          message: `bootstrap step uses {param: ${value.param}} which is not a declared credential`,
          path: ['steps', i, 'action', 'value'],
        });
      }
    });
  });
export type BootstrapRoutine = z.infer<typeof BootstrapRoutineSchema>;

/** One per vendor product. The cross-tenant reuse unit (D-019). */
export const AppProfileSchema = z
  .strictObject({
    vendorProductId: KebabIdSchema,
    name: z.string().min(1),
    surfaceKind: SurfaceKindSchema,
    bootstrap: BootstrapRoutineSchema,
    /** Shared across every capability on this product. */
    detectors: z.array(ConditionSchema),
    variants: z.record(KebabIdSchema, VariantSchema),
  })
  .superRefine((p, ctx) => {
    p.detectors.forEach((d, i) => {
      if (d.role !== 'detector') {
        ctx.addIssue({
          code: 'custom',
          message: 'profile detectors must have role detector',
          path: ['detectors', i, 'role'],
        });
      }
    });
  });
export type AppProfile = z.infer<typeof AppProfileSchema>;
