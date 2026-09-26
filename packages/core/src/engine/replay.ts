import { describePredicate, matchUrl } from '../conditions/predicate.js';
import type { ParamValues, SurfaceObservation } from '../ports/surface.js';
import { resolveTarget } from '../resolve/resolve-target.js';
import type { Capability, Condition, FailureKind, ReplayResult, Run } from '../schema/index.js';
import { newRunId } from '../store/run-id.js';
import {
  credentialsFromEnv,
  EngineArgumentError,
  EngineBase,
  type EngineDeps,
  type EngineTimeouts,
  RebootstrapSignal,
  Stop,
} from './base.js';
import { parseOutput } from './parsers.js';
import { substituteRoute } from './values.js';

export interface ReplayOptions extends EngineTimeouts {
  capability: Capability;
  params: ParamValues;
  /** Origin of the target app, e.g. http://localhost:4100. Routes resolve against it. */
  baseUrl: string;
  variantId?: string | undefined;
}

export type ReplayDeps = EngineDeps;

/** @deprecated use EngineArgumentError */
export const ReplayArgumentError = EngineArgumentError;

/**
 * Deterministic replay of a capability against a live surface. No model is involved: targets are
 * resolved from observations, every step is checkpointed, and every runtime condition is classified
 * before the engine decides what to do. docs/context/01-architecture.md §9–10.
 */
export async function replay(options: ReplayOptions, deps: ReplayDeps): Promise<ReplayResult> {
  const { capability, params } = options;
  for (const input of capability.inputs) {
    const value = params[input.name];
    if (input.required && value === undefined) {
      throw new EngineArgumentError(`missing required parameter ${input.name}`);
    }
    if (input.type === 'enum' && value !== undefined && !input.enum?.includes(value)) {
      throw new EngineArgumentError(
        `parameter ${input.name} must be one of ${input.enum?.join(', ')}`,
      );
    }
  }
  if (capability.app.vendorProductId !== deps.profile.vendorProductId) {
    throw new EngineArgumentError(
      `capability is bound to ${capability.app.vendorProductId} but the profile is ${deps.profile.vendorProductId}`,
    );
  }
  const credentials = capability.entry.requiresAuth
    ? credentialsFromEnv(deps.profile, deps.env ?? process.env)
    : {};
  return new ReplayEngine(options, deps, credentials).execute();
}

class ReplayEngine extends EngineBase {
  private readonly detectors: Condition[];

  constructor(
    private readonly options: ReplayOptions,
    deps: ReplayDeps,
    credentials: ParamValues,
  ) {
    super(deps, options.baseUrl, options, credentials);
    this.detectors = [...deps.profile.detectors, ...options.capability.detectors];
    this.sensitive = options.capability.inputs
      .filter((i) => i.sensitivity === 'sensitive' || i.sensitivity === 'secret')
      .map((i) => ({ name: i.name, value: options.params[i.name] ?? '' }))
      .filter((s) => s.value !== '');
  }

  async execute(): Promise<ReplayResult> {
    const { capability, params, baseUrl, variantId } = this.options;
    const startedAt = this.now();
    const run: Run = {
      id: newRunId(startedAt),
      kind: 'replay',
      capability: { id: capability.id, version: capability.version },
      target: {
        vendorProductId: capability.app.vendorProductId,
        ...(variantId ? { variantId } : {}),
        entry: new URL(substituteRoute(capability.entry.route, params), baseUrl).toString(),
      },
      startedAt: startedAt.toISOString(),
      controlOwner: 'automation',
      sideEffects: 'none',
    };
    this.run = await this.deps.store.runs.create(run);
    this.log(`run ${run.id} started in ${this.run.dir}`);

    let result: ReplayResult;
    try {
      if (capability.entry.requiresAuth) await this.bootstrap();
      // A session-level condition anywhere in the flow signs in again and restarts the flow from
      // its entry (D-033); the budget and the risky-step guard live in rebootstrap().
      let outputs: Record<string, unknown>;
      for (;;) {
        try {
          await this.enter();
          outputs = await this.flow();
          break;
        } catch (err) {
          if (!(err instanceof RebootstrapSignal)) throw err;
          await this.rebootstrap(err);
        }
      }
      result = this.build({ status: 'success', outputs }, undefined);
    } catch (err) {
      if (err instanceof Stop) {
        result = this.fromStop(err);
      } else {
        const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        this.log(`engine error: ${message}`);
        result = this.build(
          {
            status: 'failure',
            kind: 'UNEXPECTED_STATE',
            expected: 'the engine to complete the run',
            observed: message,
          },
          this.currentStep,
        );
      }
    }

    await this.event({ type: 'result', actor: 'automation', result });
    await this.run.update({
      finishedAt: this.now().toISOString(),
      sideEffects: result.sideEffects,
    });
    await this.run.finish(result);
    this.log(`run ${run.id} finished: ${result.status}`);
    return result;
  }

  private async enter(): Promise<void> {
    const { capability, params } = this.options;
    this.currentStep = 'entry';
    await this.navigate(substituteRoute(capability.entry.route, params), 'entry');
    for (const pre of capability.entry.preconditions) {
      const w = await this.waitFor(
        pre,
        pre.when.timeoutMs ?? this.stepTimeoutMs,
        'entry',
        this.detectors,
      );
      if (w.verdict) {
        await this.snapshot('entry', w.obs);
        this.raise(w.verdict, 'entry');
      }
      if (!w.matched) {
        await this.snapshot('entry', w.obs);
        throw new Stop(
          {
            kind: 'failure',
            failure: 'UNEXPECTED_STATE',
            expected: `at entry: ${describePredicate(pre.when)}`,
            observed: w.detail,
          },
          'entry',
        );
      }
    }
  }

  /** The compiled steps, the success condition and the outputs. */
  private async flow(): Promise<Record<string, unknown>> {
    const { capability, params } = this.options;
    for (const step of capability.steps) {
      this.checkRunTimeout();
      await this.runStep(step, params, this.detectors, false);
      await this.extractOutputsAt(step.id);
    }
    this.currentStep = undefined;
    const success = await this.waitFor(
      capability.success,
      this.stepTimeoutMs,
      'success',
      this.detectors,
    );
    if (success.verdict) {
      await this.snapshot('success', success.obs);
      this.raise(success.verdict, 'success');
    }
    if (!success.matched) {
      throw new Stop(
        {
          kind: 'failure',
          failure: 'CHECKPOINT_FAILED',
          expected: describePredicate(capability.success.when),
          observed: success.detail,
        },
        'success',
      );
    }
    return this.finalizeOutputs(success.obs);
  }

  // ---- outputs -------------------------------------------------------------------------------

  private async extractOutputsAt(stepId: string): Promise<void> {
    const obs = this.lastObservation;
    for (const spec of this.options.capability.outputs) {
      if (spec.atStep !== stepId || this.rawOutputs.has(spec.name) || !obs) continue;
      const raw = this.readOutput(spec, obs, stepId);
      if (raw !== undefined) this.rawOutputs.set(spec.name, raw);
    }
  }

  private readOutput(
    spec: Capability['outputs'][number],
    obs: SurfaceObservation,
    stepId: string,
  ): string | undefined {
    if ('urlParam' in spec.source) {
      const step = this.options.capability.steps.find((s) => s.id === stepId);
      const patterns = [step?.postcondition.when.url, this.options.capability.success.when.url];
      for (const pattern of patterns) {
        if (!pattern) continue;
        const m = matchUrl(pattern, obs);
        const value = m?.params[spec.source.urlParam];
        if (value !== undefined) return value;
      }
      return undefined;
    }
    const r = resolveTarget(obs.nodes, spec.source);
    return r.found ? (r.node.value ?? r.node.name) : undefined;
  }

  private finalizeOutputs(obs: SurfaceObservation): Record<string, unknown> {
    const outputs: Record<string, unknown> = {};
    for (const spec of this.options.capability.outputs) {
      const raw = this.rawOutputs.get(spec.name) ?? this.readOutput(spec, obs, 'success');
      const parsed = raw === undefined ? undefined : parseOutput(raw, spec);
      if (parsed === undefined) {
        if (spec.required) {
          throw new Stop(
            {
              kind: 'failure',
              failure: 'UNEXPECTED_STATE',
              expected: `output ${spec.name} (${spec.type}${spec.parser ? `, ${spec.parser}` : ''}) after step ${spec.atStep}`,
              observed:
                raw === undefined
                  ? 'no source text could be extracted'
                  : `"${raw}" could not be parsed`,
            },
            'success',
          );
        }
        continue;
      }
      outputs[spec.name] = parsed;
    }
    return outputs;
  }

  // ---- results -------------------------------------------------------------------------------

  private fromStop(stop: Stop): ReplayResult {
    switch (stop.reason.kind) {
      case 'outcome':
        return this.build(
          {
            status: 'outcome',
            code: stop.reason.code,
            message: stop.reason.message,
            ...(stop.reason.data !== undefined ? { data: stop.reason.data } : {}),
          },
          stop.atStep,
        );
      case 'failure':
        return this.build(
          {
            status: 'failure',
            kind: stop.reason.failure,
            expected: stop.reason.expected,
            observed: stop.reason.observed,
          },
          stop.atStep,
        );
      case 'stopped':
        return this.build(
          {
            status: 'failure',
            kind: 'UNEXPECTED_STATE',
            expected: 'the replay to run to completion',
            observed: `${stop.reason.status}: ${stop.reason.reason}`,
          },
          stop.atStep,
        );
    }
  }

  private build(
    head:
      | { status: 'success'; outputs: Record<string, unknown> }
      | { status: 'outcome'; code: string; message: string; data?: unknown }
      | { status: 'failure'; kind: FailureKind; expected: string; observed: string },
    atStep: string | undefined,
  ): ReplayResult {
    const { capability, variantId } = this.options;
    return {
      ...head,
      capability: { id: capability.id, version: capability.version },
      ...(variantId ? { variantId } : {}),
      ...(atStep ? { atStep } : {}),
      stepsRun: this.stepsRun,
      recoveries: this.recoveries,
      sideEffects: this.sideEffects(),
      evidence: this.evidence(head.status !== 'success'),
    };
  }
}
