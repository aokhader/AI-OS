import type { ParamValues } from '../ports/surface.js';
import type { Action, Value } from '../schema/index.js';

export class MissingParamError extends Error {
  constructor(public readonly param: string) {
    super(`no value supplied for parameter ${param}`);
    this.name = 'MissingParamError';
  }
}

export function resolveValue(v: Value, values: ParamValues): string {
  if ('text' in v) return v.text;
  const value = values[v.param];
  if (value === undefined) throw new MissingParamError(v.param);
  return value;
}

/** `/members/:memberId` → `/members/10001`. Unknown params are left in place. */
export function substituteRoute(route: string, values: ParamValues): string {
  return route.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (whole, name: string) => {
    const v = values[name];
    return v === undefined ? whole : encodeURIComponent(v);
  });
}

/** The same action with its target replaced by a live ref from the current observation. */
export function withRef(action: Action, ref: string): Action {
  switch (action.kind) {
    case 'click':
    case 'type':
    case 'select':
    case 'extract':
      return { ...action, target: { ref } };
    default:
      return action;
  }
}
