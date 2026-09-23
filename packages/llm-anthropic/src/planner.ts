import Anthropic from '@anthropic-ai/sdk';
import {
  type Decision,
  lastActionFailed,
  MAX_DECISION_ATTEMPTS,
  NUDGE_CUT_OFF,
  NUDGE_NO_TOOL_CALL,
  PLANNER_SYSTEM_PROMPT,
  type Planner,
  type PlannerInfo,
  type PlannerTurn,
  parseToolCall,
  renderTurn,
  type TranscriptEntry,
} from '@handsoff/core';
import { toolDefinitions } from './tools.js';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
const EFFORTS: ReadonlySet<string> = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

export interface AnthropicPlannerOptions {
  /** Default claude-opus-5 (D-020). */
  model?: string | undefined;
  /** Default high. */
  effort?: string | undefined;
  maxTokens?: number | undefined;
  /** Server-side refusal fallbacks (beta). Default on; a 400 for the parameter falls back to a plain request. */
  fallbacks?: boolean | undefined;
  /** How many recent user messages keep their screenshot; older ones keep text only. */
  imagesInLastTurns?: number | undefined;
  maxNodes?: number | undefined;
  log?: ((line: string) => void) | undefined;
  client?: Anthropic | undefined;
}

interface Exchange {
  /** What we sent: a plain user message on turn 1, a tool_result afterwards. */
  userText: string;
  image?: string | undefined;
  toolResultFor?: string | undefined;
  isError?: boolean | undefined;
  /** What the model answered, kept verbatim so thinking blocks are replayed unchanged. */
  assistant?: Anthropic.Beta.BetaContentBlock[] | undefined;
  toolUseId?: string | undefined;
}

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/**
 * The `Planner` over the Anthropic Messages API. A hand-written tool-use loop (D-022): every
 * tool result is a fresh observation, every action goes through the engine's gate before it
 * executes, and stop reasons are handled explicitly. The conversation is resent each turn with
 * screenshots only on the most recent turns to keep the cached prefix stable and the request small.
 */
export function createAnthropicPlanner(options: AnthropicPlannerOptions = {}): Planner {
  return new AnthropicPlanner(options);
}

class AnthropicPlanner implements Planner {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly effort: Effort;
  private readonly maxTokens: number;
  private fallbacks: boolean;
  private readonly imagesInLastTurns: number;
  private readonly maxNodes: number;
  private readonly log: (line: string) => void;
  private readonly tools = toolDefinitions();
  private readonly exchanges: Exchange[] = [];
  private readonly entries: TranscriptEntry[] = [];
  private servedBy: string | undefined;

  constructor(options: AnthropicPlannerOptions) {
    this.client = options.client ?? new Anthropic();
    this.model = options.model ?? 'claude-opus-5';
    this.effort =
      options.effort && EFFORTS.has(options.effort) ? (options.effort as Effort) : 'high';
    this.maxTokens = options.maxTokens ?? 4096;
    this.fallbacks = options.fallbacks ?? true;
    this.imagesInLastTurns = options.imagesInLastTurns ?? 2;
    this.maxNodes = options.maxNodes ?? 300;
    this.log = options.log ?? (() => undefined);
  }

  info(): PlannerInfo {
    return { provider: 'anthropic', model: this.servedBy ?? this.model, effort: this.effort };
  }

  transcript(): TranscriptEntry[] {
    return this.entries;
  }

  async decide(turn: PlannerTurn): Promise<Decision> {
    this.pushUserTurn(turn);
    let attempts = 0;
    let maxTokens = this.maxTokens;
    for (;;) {
      attempts += 1;
      const response = await this.call(maxTokens);
      this.record(turn.turn, response);
      const last = this.exchanges[this.exchanges.length - 1];
      if (last) last.assistant = response.content;

      switch (response.stop_reason) {
        case 'pause_turn':
          this.exchanges.push({ userText: '', assistant: undefined });
          continue;
        case 'max_tokens':
          if (attempts < MAX_DECISION_ATTEMPTS) {
            maxTokens *= 2;
            this.log(`response hit max_tokens; retrying with ${maxTokens}`);
            this.exchanges.push({ userText: NUDGE_CUT_OFF });
            continue;
          }
          return { kind: 'give_up', reason: 'the model kept exceeding its output budget' };
        case 'refusal': {
          const explanation = response.stop_details?.explanation ?? 'no explanation';
          return { kind: 'give_up', reason: `the model declined to continue: ${explanation}` };
        }
        default:
          break;
      }

      const toolUse = response.content.find(
        (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use',
      );
      if (!toolUse) {
        const text = response.content
          .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('\n')
          .trim();
        if (attempts < MAX_DECISION_ATTEMPTS) {
          this.log('model answered without a tool call; asking again');
          this.exchanges.push({ userText: NUDGE_NO_TOOL_CALL });
          continue;
        }
        return { kind: 'give_up', reason: text || 'the model stopped without choosing an action' };
      }

      const parsed = parseToolCall(toolUse.name, toolUse.input);
      if (last) last.toolUseId = toolUse.id;
      if (!parsed.ok) {
        if (attempts < MAX_DECISION_ATTEMPTS) {
          this.log(`rejected tool call: ${parsed.error}`);
          this.exchanges.push({ userText: parsed.error, toolResultFor: toolUse.id, isError: true });
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

  private pushUserTurn(turn: PlannerTurn): void {
    const image = turn.observation.screenshotPng
      ? Buffer.from(turn.observation.screenshotPng).toString('base64')
      : undefined;
    const previous = this.exchanges[this.exchanges.length - 1];
    if (turn.turn === 1 || !previous?.toolUseId) {
      const text = renderTurn(turn, {
        maxNodes: this.maxNodes,
        withGoal: true,
        withLastAction: false,
      });
      this.exchanges.push({ userText: text, image });
      return;
    }
    const text = renderTurn(turn, { maxNodes: this.maxNodes, withGoal: false });
    this.exchanges.push({
      userText: text,
      image,
      toolResultFor: previous.toolUseId,
      isError: lastActionFailed(turn),
    });
  }

  private messages(): Anthropic.Beta.BetaMessageParam[] {
    const messages: Anthropic.Beta.BetaMessageParam[] = [];
    const userIndexes = this.exchanges
      .map((e, i) => (e.userText !== '' ? i : -1))
      .filter((i) => i >= 0);
    const withImage = new Set(userIndexes.slice(-this.imagesInLastTurns));
    this.exchanges.forEach((e, i) => {
      if (e.userText !== '') {
        const content: Array<
          Anthropic.Beta.BetaTextBlockParam | Anthropic.Beta.BetaImageBlockParam
        > = [{ type: 'text', text: e.userText }];
        if (e.image && withImage.has(i)) {
          content.push({
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: e.image },
          });
        }
        if (e.toolResultFor) {
          messages.push({
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: e.toolResultFor,
                content,
                ...(e.isError ? { is_error: true } : {}),
              },
            ],
          });
        } else {
          messages.push({ role: 'user', content });
        }
      }
      if (e.assistant) messages.push({ role: 'assistant', content: e.assistant });
    });
    return messages;
  }

  private async call(maxTokens: number): Promise<Anthropic.Beta.BetaMessage> {
    const base: Anthropic.Beta.MessageCreateParamsNonStreaming = {
      model: this.model,
      max_tokens: maxTokens,
      thinking: { type: 'adaptive' },
      output_config: { effort: this.effort },
      system: [{ type: 'text', text: PLANNER_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      tools: this.tools,
      tool_choice: { type: 'auto', disable_parallel_tool_use: true },
      messages: this.messages(),
    };
    const params: Anthropic.Beta.MessageCreateParamsNonStreaming = this.fallbacks
      ? { ...base, betas: [FALLBACK_BETA], fallbacks: 'default' }
      : base;
    try {
      const response = await this.client.beta.messages.create(params);
      if (response.model !== this.model) this.servedBy = response.model;
      return response;
    } catch (err) {
      if (
        this.fallbacks &&
        err instanceof Anthropic.BadRequestError &&
        /fallback/i.test(err.message)
      ) {
        this.log('server-side fallbacks not accepted by the API; continuing without them');
        this.fallbacks = false;
        const response = await this.client.beta.messages.create(base);
        return response;
      }
      throw err;
    }
  }

  private record(turn: number, response: Anthropic.Beta.BetaMessage): void {
    const last = this.exchanges[this.exchanges.length - 1];
    this.entries.push({
      turn,
      at: new Date().toISOString(),
      request: {
        text: last?.userText ?? '',
        image: last?.image ? 'screenshot (omitted from transcript)' : undefined,
        toolResultFor: last?.toolResultFor,
      },
      response: {
        model: response.model,
        stop_reason: response.stop_reason,
        usage: response.usage,
        content: response.content.map((b) => {
          switch (b.type) {
            case 'text':
              return { type: 'text', text: b.text };
            case 'tool_use':
              return { type: 'tool_use', name: b.name, input: b.input };
            case 'thinking':
              return { type: 'thinking', summary: b.thinking };
            default:
              return { type: b.type };
          }
        }),
      },
    });
  }
}
