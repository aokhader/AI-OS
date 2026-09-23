import type { PlannerTurn, SurfaceObservation } from '@handsoff/core';
import OpenAI from 'openai';
import { describe, expect, it, vi } from 'vitest';
import { createOpenAiPlanner } from './planner.js';
import { resolveProvider } from './providers.js';

type Params = OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
type Completion = OpenAI.Chat.Completions.ChatCompletion;
type Message = OpenAI.Chat.Completions.ChatCompletionMessageParam;

function observation(title: string): SurfaceObservation {
  return {
    at: '2026-09-22T10:00:00.000Z',
    url: 'http://localhost:4100/',
    title,
    frames: [{ framePath: [], url: 'http://localhost:4100/', title }],
    nodes: [
      {
        ref: 'e1',
        role: 'textbox',
        name: 'Member #',
        states: [],
        bbox: { x: 0, y: 0, w: 100, h: 20 },
        framePath: [],
        path: 'form[1]/input[1]',
      },
      {
        ref: 'e2',
        role: 'button',
        name: 'Search',
        states: [],
        bbox: { x: 0, y: 30, w: 60, h: 20 },
        framePath: [],
        path: 'form[1]/button[1]',
      },
    ],
    dialogs: [],
    screenshotPng: new Uint8Array([137, 80, 78, 71]),
  };
}

function turn(n: number, extra: Partial<PlannerTurn> = {}): PlannerTurn {
  return {
    turn: n,
    goal: 'Look up member {memberId}',
    params: [
      { name: 'memberId', type: 'string', description: 'Member number', sensitivity: 'sensitive' },
    ],
    observation: observation(`Page ${n}`),
    stepsRemaining: 30 - n,
    ...extra,
  };
}

function reply(
  toolCalls: Array<{ id: string; name: string; args: string }>,
  content: string | null = null,
  finish: Completion['choices'][number]['finish_reason'] = toolCalls.length > 0
    ? 'tool_calls'
    : 'stop',
): Completion {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: 0,
    model: 'fake-model',
    choices: [
      {
        index: 0,
        finish_reason: finish,
        logprobs: null,
        message: {
          role: 'assistant',
          content,
          refusal: null,
          ...(toolCalls.length > 0
            ? {
                tool_calls: toolCalls.map((c) => ({
                  id: c.id,
                  type: 'function' as const,
                  function: { name: c.name, arguments: c.args },
                })),
              }
            : {}),
        },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function fakeClient(responses: Array<Completion | Error>) {
  const create = vi.fn(async (_params: Params) => {
    const next = responses.shift();
    if (!next) throw new Error('no more fake responses');
    if (next instanceof Error) throw next;
    return next;
  });
  // The planner only ever calls chat.completions.create; the SDK's client type is far larger.
  const client = { chat: { completions: { create } } } as unknown as OpenAI;
  return { client, create };
}

function requestOf(create: ReturnType<typeof vi.fn>, call: number): Params {
  return create.mock.calls[call]![0] as Params;
}

function userMessages(params: Params): Message[] {
  return params.messages.filter((m) => m.role === 'user');
}

function hasImage(m: Message): boolean {
  return Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url');
}

describe('OpenAI-compatible planner', () => {
  it('sends the protocol as function tools and maps a call to a Decision', async () => {
    const { client, create } = fakeClient([
      reply([
        {
          id: 'c1',
          name: 'type_param',
          args: '{"ref":"e1","param":"memberId","intent":"Enter the member number"}',
        },
      ]),
    ]);
    const planner = createOpenAiPlanner({ model: 'fake-model', provider: 'google', client });

    const decision = await planner.decide(turn(1));

    expect(decision).toEqual({
      kind: 'tool',
      intent: 'Enter the member number',
      action: { kind: 'type', target: { ref: 'e1' }, value: { param: 'memberId' }, clear: true },
    });
    const params = requestOf(create, 0);
    expect(params.model).toBe('fake-model');
    expect(params.tool_choice).toBe('auto');
    expect(params.tools?.map((t) => (t.type === 'function' ? t.function.name : t.type))).toEqual([
      'click',
      'type_text',
      'type_param',
      'select_option',
      'select_param',
      'press_key',
      'navigate',
      'wait',
      'finish',
      'give_up',
      'request_human',
    ]);
    expect(params).not.toHaveProperty('reasoning_effort');
    expect(params.messages[0]).toMatchObject({ role: 'system' });
    const user = userMessages(params)[0]!;
    expect(hasImage(user)).toBe(true);
    const text = (user.content as Array<{ type: string; text?: string }>)[0]!.text ?? '';
    expect(text).toContain('Goal: Look up member {memberId}');
    expect(text).toContain('[e2] button "Search"');
    expect(planner.info()).toEqual({ provider: 'google', model: 'fake-model', effort: undefined });
  });

  it('answers the pending tool call with the result, then sends the new observation', async () => {
    const { client, create } = fakeClient([
      reply([{ id: 'c1', name: 'click', args: '{"ref":"e2","intent":"Search"}' }]),
      reply([
        {
          id: 'c2',
          name: 'finish',
          args: '{"summary":"Done","outputs":[{"name":"balance","ref":"e1"}]}',
        },
      ]),
    ]);
    const planner = createOpenAiPlanner({ model: 'fake-model', client, imagesInLastTurns: 1 });

    const first = await planner.decide(turn(1));
    const second = await planner.decide(
      turn(2, { lastAction: { decision: first, status: 'ok', detail: 'clicked Search' } }),
    );

    expect(second).toEqual({
      kind: 'finish',
      summary: 'Done',
      outputs: { balance: { ref: 'e1' } },
    });
    const params = requestOf(create, 1);
    const roles = params.messages.map((m) => m.role);
    expect(roles).toEqual(['system', 'user', 'assistant', 'tool', 'user']);
    const tool = params.messages[3] as OpenAI.Chat.Completions.ChatCompletionToolMessageParam;
    expect(tool.tool_call_id).toBe('c1');
    expect(tool.content).toContain('ok (clicked Search)');
    const users = userMessages(params);
    expect(hasImage(users[0]!)).toBe(false);
    expect(hasImage(users[1]!)).toBe(true);
    expect(planner.transcript()).toHaveLength(2);
    expect(JSON.stringify(planner.transcript())).not.toContain('base64');
  });

  it('nudges once when the model answers in prose, then accepts the tool call', async () => {
    const { client, create } = fakeClient([
      reply([], 'I would click Search.'),
      reply([{ id: 'c1', name: 'click', args: '{"ref":"e2","intent":"Search"}' }]),
    ]);
    const log: string[] = [];
    const planner = createOpenAiPlanner({ model: 'fake-model', client, log: (l) => log.push(l) });

    const decision = await planner.decide(turn(1));

    expect(decision.kind).toBe('tool');
    expect(create).toHaveBeenCalledTimes(2);
    const roles = requestOf(create, 1).messages.map((m) => m.role);
    expect(roles).toEqual(['system', 'user', 'assistant', 'user']);
    expect(log.some((l) => l.includes('without a tool call'))).toBe(true);
  });

  it('feeds an invalid call back as a tool error and gives up after three attempts', async () => {
    const bad = { id: 'c1', name: 'click', args: '{"ref":"button","intent":"x"}' };
    const { client, create } = fakeClient([reply([bad]), reply([bad]), reply([bad])]);
    const planner = createOpenAiPlanner({ model: 'fake-model', client });

    const decision = await planner.decide(turn(1));

    expect(decision.kind).toBe('give_up');
    expect(create).toHaveBeenCalledTimes(3);
    const messages = requestOf(create, 2).messages;
    const tools = messages.filter((m) => m.role === 'tool');
    expect(tools).toHaveLength(2);
    expect(String(tools[0]!.content)).toMatch(/invalid input for click/);
  });

  it('keeps only the first of several tool calls and says so in the next result', async () => {
    const { client, create } = fakeClient([
      reply([
        { id: 'c1', name: 'click', args: '{"ref":"e2","intent":"Search"}' },
        { id: 'c2', name: 'press_key', args: '{"key":"Enter","intent":"Submit"}' },
      ]),
      reply([{ id: 'c3', name: 'give_up', args: '{"reason":"stop"}' }]),
    ]);
    const planner = createOpenAiPlanner({ model: 'fake-model', client });

    const first = await planner.decide(turn(1));
    await planner.decide(
      turn(2, { lastAction: { decision: first, status: 'ok', detail: 'clicked' } }),
    );

    const messages = requestOf(create, 1).messages;
    const assistant = messages.find(
      (m) => m.role === 'assistant',
    ) as OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam;
    expect(assistant.tool_calls).toHaveLength(1);
    const tool = messages.find(
      (m) => m.role === 'tool',
    ) as OpenAI.Chat.Completions.ChatCompletionToolMessageParam;
    expect(tool.content).toContain('1 other(s) were ignored');
  });

  it('drops images and retries when the endpoint rejects them', async () => {
    const rejection = new OpenAI.BadRequestError(
      400,
      { message: 'This model does not support image input' },
      'This model does not support image input',
      new Headers(),
    );
    const { client, create } = fakeClient([
      rejection,
      reply([{ id: 'c1', name: 'click', args: '{"ref":"e2","intent":"Search"}' }]),
    ]);
    const planner = createOpenAiPlanner({ model: 'fake-model', client });

    const decision = await planner.decide(turn(1));

    expect(decision.kind).toBe('tool');
    expect(hasImage(userMessages(requestOf(create, 0))[0]!)).toBe(true);
    expect(hasImage(userMessages(requestOf(create, 1))[0]!)).toBe(false);
  });

  it('forwards reasoning effort and drops it when the endpoint rejects it', async () => {
    const rejection = new OpenAI.BadRequestError(
      400,
      { message: 'Unrecognized request argument: reasoning_effort' },
      'Unrecognized request argument: reasoning_effort',
      new Headers(),
    );
    const { client, create } = fakeClient([
      rejection,
      reply([{ id: 'c1', name: 'click', args: '{"ref":"e2","intent":"Search"}' }]),
    ]);
    const planner = createOpenAiPlanner({ model: 'fake-model', client, reasoningEffort: 'high' });

    await planner.decide(turn(1));

    expect(requestOf(create, 0).reasoning_effort).toBe('high');
    expect(requestOf(create, 1)).not.toHaveProperty('reasoning_effort');
    expect(planner.info().effort).toBeUndefined();
  });

  it('sends no image parts when images are off', async () => {
    const { client, create } = fakeClient([
      reply([{ id: 'c1', name: 'click', args: '{"ref":"e2","intent":"Search"}' }]),
    ]);
    const planner = createOpenAiPlanner({ model: 'fake-model', client, images: false });

    await planner.decide(turn(1));

    expect(hasImage(userMessages(requestOf(create, 0))[0]!)).toBe(false);
  });
});

describe('resolveProvider', () => {
  it('fills in the Google AI Studio endpoint, key and default model', () => {
    const r = resolveProvider({ provider: 'google', env: { GEMINI_API_KEY: 'k' }, effort: 'max' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.options).toMatchObject({
      provider: 'google',
      model: 'gemini-3.8-flash',
      baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
      apiKey: 'k',
      reasoningEffort: 'high',
      images: true,
    });
  });

  it('refuses a provider without its key and says where to get one', () => {
    const r = resolveProvider({ provider: 'groq', env: {}, model: 'llama' });
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('GROQ_API_KEY') });
  });

  it('needs a model where the preset has no default, and a base URL for custom endpoints', () => {
    expect(resolveProvider({ provider: 'openai', env: { OPENAI_API_KEY: 'k' } })).toMatchObject({
      ok: false,
      error: expect.stringContaining('HANDSOFF_MODEL'),
    });
    expect(resolveProvider({ provider: 'openai-compatible', env: {}, model: 'm' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('HANDSOFF_LLM_BASE_URL'),
    });
  });

  it('warns instead of forwarding effort to endpoints that do not take it', () => {
    const r = resolveProvider({
      provider: 'ollama',
      env: {},
      model: 'qwen',
      effort: 'high',
      images: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.options.reasoningEffort).toBeUndefined();
    expect(r.options.images).toBe(true);
    expect(r.options.apiKey).toBe('none');
    expect(r.warnings[0]).toContain('effort');
  });
});
