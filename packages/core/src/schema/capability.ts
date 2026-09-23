import { z } from 'zod';
import { ActionSchema, actionParams, actionTarget } from './action.js';
import { IsoDateTimeSchema, KebabIdSchema, ParamNameSchema, RoutePathSchema } from './common.js';
import { ConditionSchema } from './condition.js';
import {
  ActorSchema,
  CapabilityStatusSchema,
  ConfirmSchema,
  RiskSchema,
  SensitivitySchema,
  SurfaceKindSchema,
} from './enums.js';
import { BaselineSchema, TargetSpecSchema } from './target.js';

export const InputSpecSchema = z
  .strictObject({
    name: ParamNameSchema,
    type: z.enum(['string', 'number', 'boolean', 'date', 'enum']),
    enum: z.array(z.string().min(1)).min(1).optional(),
    description: z.string().min(1),
    sensitivity: SensitivitySchema,
    required: z.boolean(),
    /** Never a real value for sensitive inputs. */
    example: z.string().optional(),
  })
  .superRefine((i, ctx) => {
    if (i.type === 'enum' && !i.enum) {
      ctx.addIssue({ code: 'custom', message: 'enum inputs list their values', path: ['enum'] });
    }
    if (i.type !== 'enum' && i.enum) {
      ctx.addIssue({ code: 'custom', message: 'only enum inputs list values', path: ['enum'] });
    }
  });
export type InputSpec = z.infer<typeof InputSpecSchema>;

export const OutputSpecSchema = z.strictObject({
  name: ParamNameSchema,
  type: z.enum(['string', 'number', 'boolean', 'date']),
  parser: z.enum(['currency', 'date', 'text']).optional(),
  description: z.string().min(1),
  source: z.union([TargetSpecSchema, z.strictObject({ urlParam: ParamNameSchema })]),
  /** Step id after which the output is extracted. */
  atStep: KebabIdSchema,
  required: z.boolean(),
  /** Sensitive outputs are returned in-process and masked in result.json. */
  sensitivity: SensitivitySchema,
});
export type OutputSpec = z.infer<typeof OutputSpecSchema>;

export const BindingFieldSchema = z.enum([
  'value',
  'navigate.url',
  'postcondition.url',
  'precondition.url',
]);

export const BindingSchema = z.strictObject({
  param: ParamNameSchema,
  field: BindingFieldSchema,
  /** True only for whole-segment URL canonicalisation (D-013). */
  inferred: z.boolean(),
});
export type Binding = z.infer<typeof BindingSchema>;

const stepShape = {
  id: KebabIdSchema,
  /** The model's stated reason at discovery, or the operator's. */
  intent: z.string().min(1),
  action: ActionSchema,
  /** Duplicated from the action for reviewers; absent for press, wait and navigate. */
  target: TargetSpecSchema.optional(),
  preconditions: z.array(ConditionSchema),
  /** The checkpoint. */
  postcondition: ConditionSchema,
  /** As classified at discovery; re-classified live at replay (D-015). */
  risk: RiskSchema,
  confirm: ConfirmSchema,
};

function checkStepConditions(
  step: { id: string; preconditions: Array<{ role: string }>; postcondition: { role: string } },
  ctx: z.RefinementCtx,
) {
  step.preconditions.forEach((c, i) => {
    if (c.role !== 'precondition') {
      ctx.addIssue({
        code: 'custom',
        message: 'step preconditions must have role precondition',
        path: ['preconditions', i, 'role'],
      });
    }
  });
  if (step.postcondition.role !== 'postcondition') {
    ctx.addIssue({
      code: 'custom',
      message: 'a step postcondition must have role postcondition',
      path: ['postcondition', 'role'],
    });
  }
}

function checkCompiledTarget(
  step: {
    action: z.infer<typeof ActionSchema>;
    target?: z.infer<typeof TargetSpecSchema> | undefined;
  },
  ctx: z.RefinementCtx,
) {
  const ref = actionTarget(step.action);
  if (ref && 'ref' in ref) {
    ctx.addIssue({
      code: 'custom',
      message: 'a compiled step must carry a TargetSpec, not a live ref',
      path: ['action', 'target'],
    });
  }
  if (ref && !step.target) {
    ctx.addIssue({
      code: 'custom',
      message: 'targeted actions duplicate their TargetSpec in step.target for reviewers',
      path: ['target'],
    });
  }
}

export const StepSchema = z
  .strictObject({
    ...stepShape,
    bindings: z.array(BindingSchema),
    /** Discovery resolution: which strategy resolved and how many candidates matched (D-016). */
    baseline: BaselineSchema,
    recordedBy: ActorSchema,
  })
  .superRefine((step, ctx) => {
    checkStepConditions(step, ctx);
    checkCompiledTarget(step, ctx);
    // Every parameter the action uses is declared as a binding, and vice versa.
    const used = actionParams(step.action);
    for (const u of used) {
      if (!step.bindings.some((b) => b.param === u.param && b.field === u.field)) {
        ctx.addIssue({
          code: 'custom',
          message: `action uses {param: ${u.param}} without a ${u.field} binding`,
          path: ['bindings'],
        });
      }
    }
    for (const [i, b] of step.bindings.entries()) {
      if (b.field === 'value' || b.field === 'navigate.url') {
        if (!used.some((u) => u.param === b.param && u.field === b.field)) {
          ctx.addIssue({
            code: 'custom',
            message: `binding ${b.param}/${b.field} is not used by the action`,
            path: ['bindings', i],
          });
        }
      }
      if (
        b.field === 'postcondition.url' &&
        !step.postcondition.when.url?.includes(`:${b.param}`)
      ) {
        ctx.addIssue({
          code: 'custom',
          message: `postcondition.url does not contain :${b.param}`,
          path: ['bindings', i],
        });
      }
    }
  });
export type Step = z.infer<typeof StepSchema>;

/** A bootstrap (login) step: a Step without bindings, baseline or recorder. Lives on the App Profile. */
export const BootstrapStepSchema = z.strictObject(stepShape).superRefine((step, ctx) => {
  checkStepConditions(step, ctx);
  checkCompiledTarget(step, ctx);
});
export type BootstrapStep = z.infer<typeof BootstrapStepSchema>;

export const ProvenanceSchema = z.strictObject({
  runId: z.string().min(1),
  /** Adapter and endpoint that served the discovery run, e.g. `anthropic`, `google`. */
  provider: z.string().min(1).optional(),
  /** Model that served the discovery run. */
  model: z.string().min(1),
  effort: z.string().optional(),
  recordedAt: IsoDateTimeSchema,
  variantId: KebabIdSchema.optional(),
  compiler: z.string().min(1),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const CapabilityVariantOverridesSchema = z.strictObject({
  steps: z
    .record(
      KebabIdSchema,
      z.strictObject({
        target: TargetSpecSchema.optional(),
        postcondition: ConditionSchema.optional(),
        preconditions: z.array(ConditionSchema).optional(),
      }),
    )
    .optional(),
  detectors: z.array(ConditionSchema).optional(),
});
export type CapabilityVariantOverrides = z.infer<typeof CapabilityVariantOverridesSchema>;

/**
 * The artifact: a typed, versioned, reviewable, replayable description of one flow.
 * docs/context/01-architecture.md §7 and docs/context/02-tech-stack-and-data-model.md.
 */
export const CapabilitySchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    id: KebabIdSchema,
    name: z.string().min(1),
    description: z.string().min(1),
    version: z.number().int().positive(),
    supersedes: z.number().int().positive().optional(),
    status: CapabilityStatusSchema,
    provenance: ProvenanceSchema,
    app: z.strictObject({ vendorProductId: KebabIdSchema, surfaceKind: SurfaceKindSchema }),
    entry: z.strictObject({
      route: RoutePathSchema,
      requiresAuth: z.boolean(),
      preconditions: z.array(ConditionSchema),
    }),
    inputs: z.array(InputSpecSchema),
    outputs: z.array(OutputSpecSchema),
    steps: z.array(StepSchema).min(1),
    success: ConditionSchema,
    /** The bound App Profile's detectors always apply as well. */
    detectors: z.array(ConditionSchema),
    policy: z.strictObject({
      requiredScopes: z.array(z.string().min(1)),
      /** Derived from steps; kept for reviewers. */
      riskySteps: z.array(KebabIdSchema),
    }),
    variants: z.record(KebabIdSchema, CapabilityVariantOverridesSchema).optional(),
  })
  .superRefine((cap, ctx) => {
    const stepIds = new Set<string>();
    cap.steps.forEach((s, i) => {
      if (stepIds.has(s.id)) {
        ctx.addIssue({
          code: 'custom',
          message: `duplicate step id ${s.id}`,
          path: ['steps', i, 'id'],
        });
      }
      stepIds.add(s.id);
    });
    const inputNames = new Set(cap.inputs.map((i) => i.name));

    if (cap.supersedes !== undefined && cap.supersedes >= cap.version) {
      ctx.addIssue({
        code: 'custom',
        message: 'supersedes must be an earlier version',
        path: ['supersedes'],
      });
    }
    cap.entry.preconditions.forEach((c, i) => {
      if (c.role !== 'precondition') {
        ctx.addIssue({
          code: 'custom',
          message: 'entry preconditions must have role precondition',
          path: ['entry', 'preconditions', i, 'role'],
        });
      }
    });
    if (cap.success.role !== 'postcondition') {
      ctx.addIssue({
        code: 'custom',
        message: 'success must have role postcondition',
        path: ['success', 'role'],
      });
    }
    cap.detectors.forEach((d, i) => {
      if (d.role !== 'detector') {
        ctx.addIssue({
          code: 'custom',
          message: 'detectors must have role detector',
          path: ['detectors', i, 'role'],
        });
      }
      d.atSteps?.forEach((sid, j) => {
        if (!stepIds.has(sid)) {
          ctx.addIssue({
            code: 'custom',
            message: `unknown step ${sid}`,
            path: ['detectors', i, 'atSteps', j],
          });
        }
      });
    });
    cap.steps.forEach((s, i) => {
      s.bindings.forEach((b, j) => {
        if (!inputNames.has(b.param)) {
          ctx.addIssue({
            code: 'custom',
            message: `binding refers to undeclared input ${b.param}`,
            path: ['steps', i, 'bindings', j, 'param'],
          });
        }
      });
      if (s.risk === 'risky' && !cap.policy.riskySteps.includes(s.id)) {
        ctx.addIssue({
          code: 'custom',
          message: `risky step ${s.id} must be listed in policy.riskySteps`,
          path: ['policy', 'riskySteps'],
        });
      }
    });
    cap.outputs.forEach((o, i) => {
      if (!stepIds.has(o.atStep)) {
        ctx.addIssue({
          code: 'custom',
          message: `output ${o.name} refers to unknown step ${o.atStep}`,
          path: ['outputs', i, 'atStep'],
        });
      }
    });
    cap.policy.riskySteps.forEach((sid, i) => {
      if (!stepIds.has(sid)) {
        ctx.addIssue({
          code: 'custom',
          message: `unknown step ${sid}`,
          path: ['policy', 'riskySteps', i],
        });
      }
    });
    for (const [variantId, ov] of Object.entries(cap.variants ?? {})) {
      for (const sid of Object.keys(ov.steps ?? {})) {
        if (!stepIds.has(sid)) {
          ctx.addIssue({
            code: 'custom',
            message: `variant ${variantId} overrides unknown step ${sid}`,
            path: ['variants', variantId, 'steps', sid],
          });
        }
      }
    }
  });
export type Capability = z.infer<typeof CapabilitySchema>;

export const CapabilityRefSchema = z.strictObject({
  id: KebabIdSchema,
  version: z.number().int().positive(),
});
export type CapabilityRef = z.infer<typeof CapabilityRefSchema>;
