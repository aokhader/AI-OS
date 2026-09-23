import {
  type Decision,
  MAX_DECISION_ATTEMPTS,
  NUDGE_CUT_OFF,
  NUDGE_NO_TOOL_CALL,
  type ParsedToolCall,
  PLANNER_SYSTEM_PROMPT,
  type Planner,
  type PlannerInfo,
  type PlannerTurn,
  parseToolCall,
  plannerToolSpecs,
  renderLastAction,
  renderTurn,
  type TranscriptEntry,
} from '@handsoff/core';
import OpenAI from 'openai';

type Message = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type UserContentPart = OpenAI.Chat.Completions.ChatCompletionContentPart;
type FunctionToolCall = OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall;
type ReasoningEffort = NonNullable<
  OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming['reasoning_effort']
>;

const REASONING_EFFORTS: ReadonlySet<string> = new Set([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

export interface OpenAiPlannerOptions {
  /** Model id as the endpoint names it. No default: it depends on the endpoint. */
  model: string;
  /** Label recorded in provenance, e.g. `google`. Default `openai-compatible`. */
  provider?: string | undefined;
  /** Endpoint; the SDK default is api.openai.com. */
  baseURL?: string | undefined;
  /** Key; the SDK falls back to OPENAI_API_KEY. Local endpoints accept any placeholder. */
  apiKey?: string | undefined;
  /** Sent as `reasoning_effort` when set; dropped on a 400 that names it. */
  reasoningEffort?: string | undefined;
  /** Send screenshots as image parts. Default true; dropped on a 400 that names images. */
  images?: boolean | undefined;
  /** How many recent user messages keep their screenshot; older ones keep text only. */
  imagesInLastTurns?: number | undefined;
  maxNodes?: number | undefined;
  /** Sent as `max_completion_tokens` when set. A decision is one small tool call, so unset by default. */
  maxTokens?: number | undefined;
  /** SDK retries with backoff on 429 and 5xx; free tiers rate-limit hard, so the default is 5. */
  maxRetries?: number | undefined;
  timeoutMs?: number | undefined;
  log?: ((line: string) => void) | undefined;
  client?: OpenAI | undefined;
}

/** The planner protocol's tool specs (core, D-030) as OpenAI function tools. */
export function toolDefinitions(): OpenAI.Chat.Completions.ChatCompletionFunctionTool[] {
  return plannerToolSpecs().map((spec) => ({
    type: 'function',
    function: { name: spec.name, description: spec.description, parameters: spec.parameters },
  }));
}

/**
 * The `Planner` over the OpenAI chat completions protocol, which Google AI Studio, Groq,
 * OpenRouter, Ollama and OpenAI all speak (D-031). Same loop as the Anthropic planner: every turn
 * is a fresh observation, the model answers with one function call, and invalid, missing or
 * truncated calls are retried a bounded number of times before the planner gives up. The result
 * of the previous action travels back as the tool message; the new observation follows as a user
 * message because tool messages cannot carry images. Only the most recent user messages keep their
 * screenshot.
 */
export function createOpenAiPlanner(options: OpenAiPlannerOptions): Planner {
  return new OpenAiPlanner(options);
}

class OpenAiPlanner implements Planner {
  private readonly client: OpenAI;
  private readonly provider: string;
  private readonly model: string;
  private reasoningEffort: ReasoningEffort | undefined;
  private images: boolean;
  private readonly imagesInLastTurns: number;
  private readonly maxNodes: number;
  private readonly maxTokens: number | undefined;
  private readonly log: (line: string) => void;
  private readonly tools = toolDefinitions();
  private readonly messages: Message[] = [];
  private readonly entries: TranscriptEntry[] = [];
  /** Tool call issued by the last assistant message that the next turn must answer. */
  private pendingToolCallId: string | undefined;
  /** Extra tool calls in the last reply that were dropped; mentioned in the next tool result. */
  private ignoredCalls = 0;
  private lastSent: { text: string; image: boolean; toolResultFor?: string | undefined } = {
    text: '',
    image: false,
  };
  private servedBy: string | undefined;

  constructor(options: OpenAiPlannerOptions) {
    this.client =
      options.client ??
      new OpenAI({
        ...(options.baseURL ? { baseURL: options.baseURL } : {}),
        ...(options.apiKey ? { apiKey: options.apiKey } : {}),
        maxRetries: options.maxRetries ?? 5,
        ...(options.timeoutMs ? { timeout: options.timeoutMs } : {}),
      });
    this.provider = options.provider ?? 'openai-compatible';
    this.model = options.model;
    this.reasoningEffort =
      options.reasoningEffort && REASONING_EFFORTS.has(options.reasoningEffort)
        ? (options.reasoningEffort as ReasoningEffort)
        : undefined;
    this.images = options.images ?? true;
    this.imagesInLastTurns = options.imagesInLastTurns ?? 2;
    this.maxNodes = options.maxNodes ?? 300;
    this.maxTokens = options.maxTokens;
    this.log = options.log ?? (() => undefined);
  }

  info(): PlannerInfo {
    return {
      provider: this.provider,
      model: this.servedBy ?? this.model,
      effort: this.reasoningEffort,
    };
  }

  transcript(): TranscriptEntry[] {
    return this.entries;
  }

  async decide(turn: PlannerTurn): Promise<Decision> {
    this.pushTurn(turn);
    let attempts = 0;
    for (;;) {
      attempts += 1;
      const response = await this.call();
      this.record(turn.turn, response);
      const choice = response.choices[0];
      if (!choice) return { kind: 'give_up', reason: 'the model returned no choices' };
      const message = choice.message;
      const calls = (message.tool_calls ?? []).filter(
        (c): c is FunctionToolCall => c.type === 'function',
      );
      const first = calls[0];

      if (!first) {
        const text = (message.content ?? '').trim();
        this.messages.push({ role: 'assistant', content: text });
        if (choice.finish_reason === 'content_filter') {
          return { kind: 'give_up', reason: 'the provider filtered the reply' };
        }
        if (attempts < MAX_DECISION_ATTEMPTS) {
          const cutOff = choice.finish_reason === 'length';
          this.log(
            cutOff
              ? 'reply was cut off; asking again'
              : 'model answered without a tool call; asking again',
          );
          this.pushUser(cutOff ? NUDGE_CUT_OFF : NUDGE_NO_TOOL_CALL);
          continue;
        }
        return { kind: 'give_up', reason: text || 'the model stopped without choosing an action' };
      }

      // One action per turn: keep only the first call in the history so nothing is left unanswered.
      this.messages.push({
        role: 'assistant',
        content: message.content ?? null,
        tool_calls: [first],
      });
      this.pendingToolCallId = first.id;
      this.ignoredCalls = calls.length - 1;
      if (this.ignoredCalls > 0)
        this.log(`model returned ${calls.length} tool calls; using the first`);

      const parsed = parseCall(first);
      if (!parsed.ok) {
        if (attempts < MAX_DECISION_ATTEMPTS) {
          this.log(`rejected tool call: ${parsed.error}`);
          this.pushToolResult(`Error: ${parsed.error}`);
          continue;
        }
        return {
          kind: 'give_up',
          reason: `the model kept producing invalid tool calls: ${parsed.error}`,
        };
      }
      return parsed.decision;
    }
  }

  // ---- conversation ----------------------------------------------------------------------------

  private pushTurn(turn: PlannerTurn): void {
    const image =
      this.images && turn.observation.screenshotPng
        ? Buffer.from(turn.observation.screenshotPng).toString('base64')
        : undefined;
    let toolResultFor: string | undefined;
    let text: string;
    if (this.pendingToolCallId) {
      toolResultFor = this.pendingToolCallId;
      this.pushToolResult(renderLastAction(turn));
      text = renderTurn(turn, { maxNodes: this.maxNodes, withGoal: false, withLastAction: false });
    } else {
      text = renderTurn(turn, {
        maxNodes: this.maxNodes,
        withGoal: true,
        withLastAction: turn.turn !== 1,
      });
    }
    const content: UserContentPart[] = [{ type: 'text', text }];
    if (image) {
      content.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${image}` } });
    }
    this.messages.push({ role: 'user', content });
    this.lastSent = { text, image: image !== undefined, toolResultFor };
  }

  private pushUser(text: string): void {
    this.messages.push({ role: 'user', content: text });
    this.lastSent = { text, image: false };
  }

  private pushToolResult(text: string): void {
    if (!this.pendingToolCallId) return;
    const note =
      this.ignoredCalls > 0
        ? ` Only the first tool call of your reply was executed; ${this.ignoredCalls} other(s) were ignored. Reply with exactly one tool call.`
        : '';
    this.messages.push({
      role: 'tool',
      tool_call_id: this.pendingToolCallId,
      content: `${text}${note}`,
    });
    this.lastSent = { text: `${text}${note}`, image: false, toolResultFor: this.pendingToolCallId };
    this.pendingToolCallId = undefined;
    this.ignoredCalls = 0;
  }

  /** The system prompt plus the history, with screenshots only on the most recent user messages. */
  private requestMessages(): Message[] {
    const withImage: number[] = [];
    this.messages.forEach((m, i) => {
      if (hasImage(m)) withImage.push(i);
    });
    const keep = new Set(withImage.slice(-this.imagesInLastTurns));
    const history = this.messages.map((m, i) =>
      hasImage(m) && !keep.has(i) ? withoutImages(m) : m,
    );
    return [{ role: 'system', content: PLANNER_SYSTEM_PROMPT }, ...history];
  }

  private dropAllImages(): void {
    this.messages.forEach((m, i) => {
      if (hasImage(m)) this.messages[i] = withoutImages(m);
    });
  }

  private async call(): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
      model: this.model,
      messages: this.requestMessages(),
      tools: this.tools,
      tool_choice: 'auto',
      ...(this.reasoningEffort ? { reasoning_effort: this.reasoningEffort } : {}),
      ...(this.maxTokens ? { max_completion_tokens: this.maxTokens } : {}),
    };
    try {
      const response = await this.client.chat.completions.create(params);
      if (response.model && response.model !== this.model) this.servedBy = response.model;
      return response;
    } catch (err) {
      if (err instanceof OpenAI.BadRequestError) {
        if (this.reasoningEffort && /reasoning/i.test(err.message)) {
          this.log('reasoning_effort not accepted by the endpoint; continuing without it');
          this.reasoningEffort = undefined;
          return this.call();
        }
        if (this.images && /image|vision|multimodal/i.test(err.message)) {
          this.log('images not accepted by the endpoint; continuing with text only');
          this.images = false;
          this.dropAllImages();
          return this.call();
        }
      }
      throw err;
    }
  }

  private record(turn: number, response: OpenAI.Chat.Completions.ChatCompletion): void {
    const choice = response.choices[0];
    const calls = (choice?.message.tool_calls ?? []).filter(
      (c): c is FunctionToolCall => c.type === 'function',
    );
    this.entries.push({
      turn,
      at: new Date().toISOString(),
      request: {
        text: this.lastSent.text,
        image: this.lastSent.image ? 'screenshot (omitted from transcript)' : undefined,
        toolResultFor: this.lastSent.toolResultFor,
      },
      response: {
        model: response.model,
        finish_reason: choice?.finish_reason ?? null,
        usage: response.usage,
        content: choice?.message.content ?? null,
        tool_calls: calls.map((c) => ({
          name: c.function.name,
          arguments: parseJson(c.function.arguments) ?? c.function.arguments,
        })),
      },
    });
  }
}

// ---- helpers -----------------------------------------------------------------------------------

function parseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function parseCall(call: FunctionToolCall): ParsedToolCall {
  const args = call.function.arguments.trim() === '' ? {} : parseJson(call.function.arguments);
  if (args === undefined) {
    return { ok: false, error: `arguments of ${call.function.name} are not valid JSON` };
  }
  return parseToolCall(call.function.name, args);
}

function hasImage(m: Message): boolean {
  return (
    m.role === 'user' && Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url')
  );
}

function withoutImages(m: Message): Message {
  if (m.role !== 'user' || !Array.isArray(m.content)) return m;
  return { ...m, content: m.content.filter((p) => p.type !== 'image_url') };
}
