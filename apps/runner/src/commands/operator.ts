import { createInterface } from 'node:readline/promises';
import type { Action, ConfirmRequest, Operator } from '@handsoff/core';

/**
 * Who answers a `confirm` verdict (D-034). `tty` asks in the terminal, `approve-all` answers yes
 * to everything (an attended discovery of a write flow), `none` attaches nobody, so replay stops
 * before a risky step with ESCALATION_ABANDONED and discovery is told to find another route.
 */
export type OperatorMode = 'tty' | 'none' | 'approve-all';
export const OPERATOR_MODES: readonly OperatorMode[] = ['tty', 'none', 'approve-all'];

export interface ResolvedOperator {
  mode: OperatorMode;
  operator: Operator | undefined;
}

/** `--operator`, else HANDSOFF_OPERATOR, else `tty` when stdin is a terminal and `none` otherwise. */
export function resolveOperator(
  requested: string | undefined,
  env: Record<string, string | undefined>,
  interactive: boolean,
): { ok: true; value: ResolvedOperator } | { ok: false; error: string } {
  const raw = requested ?? (env.HANDSOFF_OPERATOR || undefined) ?? (interactive ? 'tty' : 'none');
  if (!(OPERATOR_MODES as readonly string[]).includes(raw)) {
    return {
      ok: false,
      error: `--operator must be one of ${OPERATOR_MODES.join(' | ')}, got "${raw}"`,
    };
  }
  const mode = raw as OperatorMode;
  switch (mode) {
    case 'none':
      return { ok: true, value: { mode, operator: undefined } };
    case 'approve-all':
      return { ok: true, value: { mode, operator: createApproveAllOperator() } };
    case 'tty':
      if (!interactive) {
        return {
          ok: false,
          error: '--operator tty needs an interactive terminal; use --operator none or approve-all',
        };
      }
      return { ok: true, value: { mode, operator: createTerminalOperator() } };
  }
}

function describeValue(v: { text: string } | { param: string }): string {
  return 'param' in v ? `{${v.param}}` : JSON.stringify(v.text);
}

export function describeAction(action: Action): string {
  switch (action.kind) {
    case 'type':
    case 'select':
      return `${action.kind} ${describeValue(action.value)}`;
    case 'navigate':
      return `navigate ${describeValue(action.url)}`;
    case 'press':
      return `press ${action.key}`;
    case 'extract':
      return `extract ${action.name}`;
    default:
      return action.kind;
  }
}

export function renderConfirmRequest(req: ConfirmRequest): string {
  return [
    '',
    `── operator confirmation required · ${req.cause} ──`,
    `  run ${req.runId} (${req.phase}) · step ${req.stepId} · ${req.intent}`,
    `  action: ${describeAction(req.action)}${req.target ? ` on ${req.target}` : ''}`,
    `  rule: ${req.rule}`,
    `  ${req.reason}`,
    ...(req.screenshot ? [`  screenshot: ${req.screenshot}`] : []),
    '',
  ].join('\n');
}

/** Asks on stderr, reads one line from stdin. Anything but y/yes is a denial. */
export function createTerminalOperator(
  io: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream } = {
    input: process.stdin,
    output: process.stderr,
  },
): Operator {
  return {
    info: () => ({ id: 'terminal' }),
    async confirm(req) {
      const rl = createInterface({ input: io.input, output: io.output });
      try {
        io.output.write(renderConfirmRequest(req));
        const answer = await rl.question('  approve this step? [y/N] ');
        return /^y(es)?$/i.test(answer.trim()) ? 'approved' : 'denied';
      } finally {
        rl.close();
      }
    },
  };
}

export function createApproveAllOperator(log?: (line: string) => void): Operator {
  return {
    info: () => ({ id: 'cli:approve-all' }),
    async confirm(req) {
      log?.(`approve-all: ${req.cause} at ${req.stepId} (${req.reason}) → approved`);
      return 'approved';
    },
  };
}
