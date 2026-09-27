import { createInterface } from 'node:readline/promises';
import type { Escalation, EscalationControls, HandBackKind, Operator } from '@handsoff/core';
import { createConsoleOperator, LiveRegistry } from '../server/live.js';

/**
 * Who answers an escalation (D-034, D-036). `tty` asks in the terminal, `console` hands it to
 * the operator console over the live API this process serves, `approve-all` approves every
 * confirmation and aborts anything else (an attended discovery of a write flow), `none` attaches
 * nobody, so the escalation is abandoned at once: replay stops before the step, discovery is told
 * to find another route.
 */
export type OperatorMode = 'tty' | 'none' | 'approve-all' | 'console';
export const OPERATOR_MODES: readonly OperatorMode[] = ['tty', 'none', 'approve-all', 'console'];

export interface ResolvedOperator {
  mode: OperatorMode;
  operator: Operator | undefined;
  /** Present for `console`: the live API serves it. */
  registry: LiveRegistry | undefined;
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
      return { ok: true, value: { mode, operator: undefined, registry: undefined } };
    case 'approve-all':
      return {
        ok: true,
        value: { mode, operator: createApproveAllOperator(), registry: undefined },
      };
    case 'console': {
      const registry = new LiveRegistry();
      return { ok: true, value: { mode, operator: createConsoleOperator(registry), registry } };
    }
    case 'tty':
      if (!interactive) {
        return {
          ok: false,
          error:
            '--operator tty needs an interactive terminal; use --operator console, approve-all or none',
        };
      }
      return { ok: true, value: { mode, operator: createTerminalOperator(), registry: undefined } };
  }
}

export function renderEscalation(e: Escalation): string {
  const subject = e.capability ? `${e.capability.id} v${e.capability.version}` : (e.goal ?? '');
  return [
    '',
    `── escalation ${e.id} · ${e.cause} ──`,
    `  run ${e.runId} (${e.phase}) · ${subject}`,
    `  at ${e.atStep ?? 'run'}${e.stepIntent ? ` · ${e.stepIntent}` : ''}`,
    `  ${e.detail}`,
    `  screenshot: ${e.screenshot}`,
    '',
  ].join('\n');
}

const LABELS: Record<HandBackKind, string> = {
  approve_step: '[a]pprove the step and let automation run it',
  resume: '[r]esume automation from wherever you left the page',
  mark_complete: '[m]ark the goal complete and let automation read the result',
  abort: 'a[b]ort the run',
};
const KEYS: Record<string, HandBackKind> = {
  a: 'approve_step',
  r: 'resume',
  m: 'mark_complete',
  b: 'abort',
};

/**
 * Asks on stderr, reads from stdin. Before a claim the choices are the suggested actions plus
 * `c` to claim; after a claim the person works in the browser window and then hands back.
 */
export function createTerminalOperator(
  io: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream } = {
    input: process.stdin,
    output: process.stderr,
  },
): Operator {
  const id = 'terminal';
  return {
    info: () => ({ id }),
    async escalate(escalation, controls: EscalationControls) {
      const rl = createInterface({ input: io.input, output: io.output });
      try {
        io.output.write(renderEscalation(escalation));
        const offered = escalation.suggestedActions;
        const menu = (claimed: boolean) =>
          [
            ...(claimed ? [] : ['  [c]laim and work in the browser window']),
            ...offered
              .filter((k) => claimed || k !== 'resume' || true)
              .map((k) => `  ${LABELS[k]}`),
            '',
          ].join('\n');
        let claimed = false;
        for (let attempt = 0; attempt < 4; attempt++) {
          io.output.write(menu(claimed));
          const answer = (await rl.question('  your choice: ')).trim().toLowerCase();
          if (!claimed && answer === 'c') {
            await controls.claim(id);
            claimed = true;
            io.output.write(
              '\n  You have control. Every click, change and Enter in the browser is recorded. When you are done, hand back:\n',
            );
            continue;
          }
          const kind = KEYS[answer];
          if (kind && offered.includes(kind)) {
            await controls.handBack(kind, id);
            return;
          }
          io.output.write('  not one of the choices\n');
        }
        io.output.write('  no valid choice; aborting\n');
        await controls.handBack('abort', id);
      } finally {
        rl.close();
      }
    },
  };
}

/** Approves every CONFIRM_REQUIRED escalation and aborts any other cause. */
export function createApproveAllOperator(log?: (line: string) => void): Operator {
  const id = 'cli:approve-all';
  return {
    info: () => ({ id }),
    async escalate(escalation, controls) {
      const kind: HandBackKind = escalation.suggestedActions.includes('approve_step')
        ? 'approve_step'
        : 'abort';
      log?.(`approve-all: ${escalation.cause} at ${escalation.atStep} → ${kind}`);
      await controls.handBack(kind, id);
    },
  };
}
