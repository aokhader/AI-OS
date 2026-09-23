import { z } from 'zod';
import type { PlannerParam, PlannerTurn } from '../ports/planner.js';
import type { SurfaceObservation } from '../ports/surface.js';
import type { Decision } from '../schema/index.js';

/**
 * The planner protocol: what every model-backed `Planner` says to a model and how it reads the
 * answer back. Provider packages (`@handsoff/llm-anthropic`, `@handsoff/llm-openai`) only translate
 * these tool specs and texts into their wire format (D-030). Nothing here touches an SDK.
 *
 * Tools are flat and strict: one tool per action kind, and separate `*_param` tools so a parameter
 * is referenced by name and its value never enters the transcript (D-013, D-028). The engine
 * validates every resulting `Decision` again before acting.
 */
const Ref = z
  .string()
  .regex(/^(e\d+|dialog(-ok|-cancel)?)$/)
  .describe('A ref from the current observation, for example e12.');
const Intent = z.string().min(1).max(240).describe('One short sentence: what this action is for.');
const ParamName = z
  .string()
  .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/)
  .describe('The name of a task parameter. The system supplies its value; you never see it.');

export const toolInputSchemas = {
  click: z.strictObject({ ref: Ref, intent: Intent }),
  type_text: z.strictObject({
    ref: Ref,
    text: z.string().describe('Literal text to type. Never a value that belongs to a parameter.'),
    intent: Intent,
  }),
  type_param: z.strictObject({ ref: Ref, param: ParamName, intent: Intent }),
  select_option: z.strictObject({
    ref: Ref,
    option: z.string().describe('The visible label of the option to choose.'),
    intent: Intent,
  }),
  select_param: z.strictObject({ ref: Ref, param: ParamName, intent: Intent }),
  press_key: z.strictObject({
    key: z.string().describe('A key name such as Enter, Tab or Escape.'),
    intent: Intent,
  }),
  navigate: z.strictObject({
    url: z.string().describe('An absolute URL or a path on the current site.'),
    intent: Intent,
  }),
  wait: z.strictObject({
    seconds: z.number().min(0.5).max(10),
    reason: z.string().min(1).max(240),
  }),
  finish: z.strictObject({
    summary: z
      .string()
      .min(1)
      .max(500)
      .describe('How the goal was achieved, in one or two sentences.'),
    outputs: z
      .array(
        z.strictObject({
          name: ParamName.describe('Output name in camelCase, e.g. savingsBalance.'),
          ref: Ref.describe('The element whose text holds the value.'),
        }),
      )
      .describe('Every value the goal asks for, read from the page.'),
  }),
  give_up: z.strictObject({ reason: z.string().min(1).max(500) }),
  request_human: z.strictObject({
    reason: z.string().min(1).max(500).describe('What a human operator needs to do or decide.'),
  }),
} as const;

export type ToolName = keyof typeof toolInputSchemas;

export const toolDescriptions: Record<ToolName, string> = {
  click: 'Click a link, button, checkbox or other element by ref.',
  type_text: 'Type literal text into a text field by ref, replacing its current content.',
  type_param:
    'Type the value of a named task parameter into a text field by ref. Use this whenever a field should contain a parameter.',
  select_option: 'Choose an option in a dropdown by its visible label.',
  select_param: 'Choose the option in a dropdown that matches the value of a named task parameter.',
  press_key: 'Press a keyboard key such as Enter.',
  navigate: 'Go to a URL on the current site.',
  wait: 'Wait for the page to settle before observing again. Use sparingly.',
  finish: 'Declare the goal achieved and name the elements that hold each requested output.',
  give_up: 'Stop because the goal cannot be achieved from here. Say why.',
  request_human:
    'Stop and ask a human operator to take over the live session. Say what they need to do.',
};

/** A tool as every provider sees it: name, description and a JSON Schema for its input. */
export interface PlannerToolSpec {
  name: ToolName;
  description: string;
  /** JSON Schema draft 2020-12 generated from the zod schema, `$schema` stripped. */
  parameters: { type: 'object'; [key: string]: unknown };
}

function parametersOf(schema: z.ZodType): PlannerToolSpec['parameters'] {
  const json = z.toJSONSchema(schema, { target: 'draft-2020-12' }) as Record<string, unknown>;
  const { $schema: _ignored, ...rest } = json;
  return { ...rest, type: 'object' };
}

export function plannerToolSpecs(): PlannerToolSpec[] {
  return (Object.keys(toolInputSchemas) as ToolName[]).map((name) => ({
    name,
    description: toolDescriptions[name],
    parameters: parametersOf(toolInputSchemas[name]),
  }));
}

export type ParsedToolCall = { ok: true; decision: Decision } | { ok: false; error: string };

/** Validates a tool call from any provider and maps it to a core Decision. */
export function parseToolCall(name: string, input: unknown): ParsedToolCall {
  if (!(name in toolInputSchemas)) return { ok: false, error: `unknown tool ${name}` };
  const tool = name as ToolName;
  const parsed = toolInputSchemas[tool].safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    return { ok: false, error: `invalid input for ${tool}: ${issues.join('; ')}` };
  }
  const d = parsed.data as z.infer<(typeof toolInputSchemas)[ToolName]>;
  switch (tool) {
    case 'click': {
      const a = d as z.infer<typeof toolInputSchemas.click>;
      return {
        ok: true,
        decision: {
          kind: 'tool',
          intent: a.intent,
          action: { kind: 'click', target: { ref: a.ref } },
        },
      };
    }
    case 'type_text': {
      const a = d as z.infer<typeof toolInputSchemas.type_text>;
      return {
        ok: true,
        decision: {
          kind: 'tool',
          intent: a.intent,
          action: { kind: 'type', target: { ref: a.ref }, value: { text: a.text }, clear: true },
        },
      };
    }
    case 'type_param': {
      const a = d as z.infer<typeof toolInputSchemas.type_param>;
      return {
        ok: true,
        decision: {
          kind: 'tool',
          intent: a.intent,
          action: { kind: 'type', target: { ref: a.ref }, value: { param: a.param }, clear: true },
        },
      };
    }
    case 'select_option': {
      const a = d as z.infer<typeof toolInputSchemas.select_option>;
      return {
        ok: true,
        decision: {
          kind: 'tool',
          intent: a.intent,
          action: { kind: 'select', target: { ref: a.ref }, value: { text: a.option } },
        },
      };
    }
    case 'select_param': {
      const a = d as z.infer<typeof toolInputSchemas.select_param>;
      return {
        ok: true,
        decision: {
          kind: 'tool',
          intent: a.intent,
          action: { kind: 'select', target: { ref: a.ref }, value: { param: a.param } },
        },
      };
    }
    case 'press_key': {
      const a = d as z.infer<typeof toolInputSchemas.press_key>;
      return {
        ok: true,
        decision: { kind: 'tool', intent: a.intent, action: { kind: 'press', key: a.key } },
      };
    }
    case 'navigate': {
      const a = d as z.infer<typeof toolInputSchemas.navigate>;
      return {
        ok: true,
        decision: {
          kind: 'tool',
          intent: a.intent,
          action: { kind: 'navigate', url: { text: a.url } },
        },
      };
    }
    case 'wait': {
      const a = d as z.infer<typeof toolInputSchemas.wait>;
      return {
        ok: true,
        decision: {
          kind: 'tool',
          intent: a.reason,
          action: { kind: 'wait', reason: a.reason, ms: Math.round(a.seconds * 1000) },
        },
      };
    }
    case 'finish': {
      const a = d as z.infer<typeof toolInputSchemas.finish>;
      const outputs: Record<string, { ref: string }> = {};
      for (const o of a.outputs) outputs[o.name] = { ref: o.ref };
      return { ok: true, decision: { kind: 'finish', outputs, summary: a.summary } };
    }
    case 'give_up': {
      const a = d as z.infer<typeof toolInputSchemas.give_up>;
      return { ok: true, decision: { kind: 'give_up', reason: a.reason } };
    }
    case 'request_human': {
      const a = d as z.infer<typeof toolInputSchemas.request_human>;
      return { ok: true, decision: { kind: 'request_human', reason: a.reason } };
    }
  }
}

// ---- prompt and rendering -----------------------------------------------------------------------

export const PLANNER_SYSTEM_PROMPT = `You are operating a legacy business application through a browser for HandsOff, a system that records how a task is done once so it can be replayed later without you.

Each turn you receive the current page as a list of elements with refs (for example [e12]), and a screenshot when your provider accepts images, and you reply with exactly one tool call. Refs are valid only for the observation they came with.

The task has named parameters whose values you never see. To enter one, call type_param or select_param with the parameter's name and the system substitutes the real value. Never type or guess a value that belongs to a parameter.

Prefer reading and navigating over changing data. Do not submit forms or perform actions that create, change or delete records unless the goal explicitly requires it. If you cannot make progress, are unsure whether an action is safe, or the application is in an unexpected state, call request_human or give_up with a clear reason instead of trying actions at random.

When the goal is achieved, call finish with a short summary and the outputs the goal asks for, each as the ref of the element whose text holds the value.`;

const MAX_NAME = 160;
export const DEFAULT_MAX_NODES = 300;

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function frameLabel(framePath: string[]): string {
  return framePath.length === 0 ? 'top' : framePath.join('/');
}

/**
 * A compact text view of an observation for the model: one line per element with its ref, role,
 * name, value and frame. Empty cells and other noise are dropped. The observation is expected to
 * be redacted already.
 */
export function renderObservation(obs: SurfaceObservation, maxNodes = DEFAULT_MAX_NODES): string {
  const lines: string[] = [];
  lines.push(`Page: ${obs.title || '(untitled)'}`);
  lines.push(
    `Frames: ${obs.frames.map((f) => `[${frameLabel(f.framePath)}] ${f.url}`).join(' | ')}`,
  );
  if (obs.dialogs.length > 0) {
    lines.push(
      `Open dialogs: ${obs.dialogs.map((d) => `${d.kind} "${truncate(d.text, 200)}"`).join('; ')}`,
    );
  }
  lines.push('Elements (ref role "name" value @frame):');
  const shown = obs.nodes.filter(
    (n) => n.name.trim() !== '' || n.value !== undefined || n.role !== 'cell',
  );
  for (const n of shown.slice(0, maxNodes)) {
    const value = n.value !== undefined ? ` value="${truncate(n.value, 80)}"` : '';
    const states = n.states.length > 0 ? ` {${n.states.join(',')}}` : '';
    lines.push(
      `[${n.ref}] ${n.role} "${truncate(n.name, MAX_NAME)}"${value}${states} @${frameLabel(n.framePath)}`,
    );
  }
  if (shown.length > maxNodes) lines.push(`(${shown.length - maxNodes} more elements omitted)`);
  return lines.join('\n');
}

export function renderParams(params: PlannerParam[]): string {
  if (params.length === 0) return 'Parameters: none';
  return [
    'Parameters (use them by name with type_param or select_param; you never see their values):',
    ...params.map((p) => `- ${p.name} (${p.type}, ${p.sensitivity}): ${p.description}`),
  ].join('\n');
}

/** The goal and its parameters, sent once at the start of the conversation. */
export function renderGoal(turn: PlannerTurn): string {
  return [`Goal: ${turn.goal}`, renderParams(turn.params)].join('\n');
}

/** One line on what happened to the previous decision. */
export function renderLastAction(turn: PlannerTurn): string {
  return turn.lastAction
    ? `Result of your last action: ${turn.lastAction.status} (${turn.lastAction.detail}).`
    : 'Result of your last action: unknown.';
}

export function lastActionFailed(turn: PlannerTurn): boolean {
  return turn.lastAction?.status === 'invalid' || turn.lastAction?.status === 'failed';
}

export interface RenderTurnOptions {
  maxNodes?: number | undefined;
  /** Default: the first turn. */
  withGoal?: boolean | undefined;
  /** Default: every turn but the first. Set false when the result travels in a separate message. */
  withLastAction?: boolean | undefined;
}

/** The full text of one turn: goal or last-action line, remaining budget, then the observation. */
export function renderTurn(turn: PlannerTurn, options: RenderTurnOptions = {}): string {
  const withGoal = options.withGoal ?? turn.turn === 1;
  const withLastAction = options.withLastAction ?? turn.turn !== 1;
  const lines: string[] = [];
  if (withGoal) lines.push(renderGoal(turn));
  if (withLastAction) lines.push(renderLastAction(turn));
  lines.push(
    `Steps remaining: ${turn.stepsRemaining}`,
    '',
    renderObservation(turn.observation, options.maxNodes),
  );
  return lines.join('\n');
}

/** What a planner says when the model answered without a tool call or was cut off. */
export const NUDGE_NO_TOOL_CALL =
  'Reply with exactly one tool call. If the goal cannot be achieved, call give_up.';
export const NUDGE_CUT_OFF = 'Your reply was cut off. Answer again with exactly one tool call.';
/** How many times one decision is retried on an invalid, missing or truncated tool call. */
export const MAX_DECISION_ATTEMPTS = 3;
