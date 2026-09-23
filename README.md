# HandsOff

Computer-use automation for legacy banking software. An LLM figures out how to complete a goal in a UI once; the run is compiled into a typed, versioned, replayable **capability**; from then on the capability replays deterministically with no model in the loop, explicit error handling, safety guardrails, and a human escalation path that hands over the live browser session.

Take-home assessment for interface.ai. The brief is at [docs/description.md](docs/description.md). The project's working knowledge base, read at the start of every session, is [docs/context/](docs/context/README.md).

> Status: P1 complete, P2 built. Deterministic replay works end to end against the mock app, and discovery compiles a run into a capability that replays; the one real model-driven run for `/evidence/` still has to be recorded with an API key for any supported provider. The design write-up (`/REPORT.md`) lands in P8. See [docs/context/04-roadmap.md](docs/context/04-roadmap.md).

## Layout

```
packages/core                schemas, engines, policy, redaction (no runtime deps)
packages/surface-playwright  Surface implementation over Playwright        (P1)
packages/llm-anthropic       Planner over the Anthropic SDK                        (P2)
packages/llm-openai          Planner over the OpenAI protocol: Google AI Studio,
                             Groq, OpenRouter, Ollama, any compatible endpoint     (P2)
apps/runner                  `handsoff` CLI with embedded API and console  (P3+)
apps/operator-console        Vite + React operator console                 (P3+)
apps/legacy-bank             mock legacy credit-union app, the target      (P0)
config/policy.json           allowlist and risk policy
data/app-profiles/           per vendor product profiles (committed)
docs/context/                architecture, data model, decisions, roadmap
```

## Quick start

```bash
pnpm install
pnpm --filter @handsoff/surface-playwright exec playwright install chromium
cp .env.example .env
pnpm dev          # mock legacy bank app on http://localhost:4100 (sign in: teller / value of LEGACY_BANK_PASS)
```

Replay a saved capability with no LLM involved (in a second terminal; the browser opens headed unless `HANDSOFF_HEADLESS=true`):

```bash
pnpm handsoff replay --capability get-member-savings-balance --param memberId=10001
```

Exit code 0 and `{"savingsBalance": 1250.75}` on stdout; the run folder with screenshots, `events.jsonl` and `result.json` is printed on stderr. An unknown member is a business outcome, not a failure:

```bash
pnpm handsoff replay --capability get-member-savings-balance --param memberId=99999   # outcome MEMBER_NOT_FOUND, exit 3
```

Discover a capability with a model. Put a key for any supported provider in `.env`; the free Google AI Studio tier is enough:

```bash
# .env
HANDSOFF_LLM_PROVIDER=google
GEMINI_API_KEY=...            # https://aistudio.google.com/apikey
```

Other providers: `anthropic` (`ANTHROPIC_API_KEY`), `openai` (`OPENAI_API_KEY`), `groq` (`GROQ_API_KEY`), `openrouter` (`OPENROUTER_API_KEY`), `ollama` (local, no key), or `openai-compatible` with `HANDSOFF_LLM_BASE_URL`. With `HANDSOFF_LLM_PROVIDER` empty the CLI uses whichever key it finds, and `--provider` overrides both. `HANDSOFF_MODEL` overrides the provider's default model (`claude-opus-5`, `gemini-3.8-flash`; the others need it set). The browser is headed so you can watch:

```bash
pnpm handsoff discover --goal "Look up member {memberId} and return the current balance of the Savings account" --param memberId=10001 --sensitive memberId --describe "memberId=Member number as printed on the member card" --id get-member-savings-balance --outcome "MEMBER_NOT_FOUND=No matching member"
```

The run folder holds every observation, decision, policy check and action, the screenshots, and the model transcript with parameter values redacted. The compiled capability is written as the next version of the id and replays with the command above. To keep a run as submission evidence:

```bash
pnpm evidence:copy <runId> discovery-run
```

The same discovery without a model, following a script of targets (offline demo, also what the integration test runs):

```bash
pnpm handsoff discover --goal "Look up member {memberId} and return the current balance of the Savings account" --param memberId=10001 --sensitive memberId --id get-member-savings-balance-scripted --outcome "MEMBER_NOT_FOUND=No matching member" --scripted data/discovery-scripts/get-member-savings-balance.json
```

Checks:

```bash
pnpm test               # schema, resolver, classifier, compiler and mock-app tests; no browser, no API key
pnpm test:integration   # real headless Chromium against the in-process mock app: replay, and discover → compile → replay; no API key
pnpm typecheck
pnpm lint
```
