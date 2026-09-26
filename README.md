# HandsOff

Computer-use automation for legacy banking software. An LLM figures out how to complete a goal in a UI once; the run is compiled into a typed, versioned, replayable **capability**; from then on the capability replays deterministically with no model in the loop, explicit error handling, safety guardrails, and a human escalation path that hands over the live browser session.

Take-home assessment for interface.ai. The brief is at [docs/description.md](docs/description.md). The project's working knowledge base, read at the start of every session, is [docs/context/](docs/context/README.md).

> Status: P0–P4 complete. Deterministic replay works end to end against the mock app; a real model-driven discovery (Gemini via Google AI Studio) compiled `get-member-savings-balance` v3, which replays to the balance and to the not-found outcome; that run is in [evidence/discovery-run](evidence/discovery-run). Every runtime condition in the brief is injectable in the mock app and answered by the classifier: business outcomes stop with a code, interstitials, busy pages and session expiry are recovered and reported, error pages fail with evidence. The console lists runs and capabilities. Next: P5 policy gate, redaction and screenshot masking. The design write-up (`/REPORT.md`) lands in P8. See [docs/context/04-roadmap.md](docs/context/04-roadmap.md).

## Layout

```
packages/core                schemas, engines, policy, redaction (no runtime deps)
packages/surface-playwright  Surface implementation over Playwright        (P1)
packages/llm-anthropic       Planner over the Anthropic SDK                        (P2)
packages/llm-openai          Planner over the OpenAI protocol: Google AI Studio,
                             Groq, OpenRouter, Ollama, any compatible endpoint     (P2)
apps/runner                  `handsoff` CLI: discover, replay, serve (API)   (P1–P3)
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

Exit code 0 and `{"savingsBalance": 1250.75}` on stdout; the run folder with screenshots, `events.jsonl` and `result.json` is printed on stderr. When piping stdout into another tool, use `pnpm --silent handsoff …` so pnpm's own failure line does not follow the JSON on a non-zero exit. An unknown member is a business outcome, not a failure:

```bash
pnpm handsoff replay --capability get-member-savings-balance --param memberId=99999   # outcome MEMBER_NOT_FOUND, exit 3
```

Inject a runtime condition into the mock app and watch the classifier answer it (each mode fires once per browser; see [docs/context/02](docs/context/02-tech-stack-and-data-model.md#configuration-and-environment)):

```bash
pnpm handsoff replay --capability get-member-savings-balance --param memberId=10001 --chaos session-expiry   # success, one rebootstrap recovery, s1 and s2 at two attempts
```

```bash
pnpm handsoff replay --capability get-member-savings-balance --param memberId=10001 --chaos interstitial     # success, one dismissed System notice
```

```bash
pnpm handsoff replay --capability get-member-savings-balance --param memberId=10001 --chaos error            # failure APP_ERROR at s2 with screenshot and snapshot
```

Other modes: `not-found` and `slow` (busy page waited out with wait-retry). The second capability, `open-sub-account`, was discovered by a model too and exercises the write path; `validation` rejects its submit once:

```bash
pnpm handsoff replay --capability open-sub-account --param memberId=10001 --param "accountType=Checking" --param deposit=40.00 --chaos validation   # outcome VALIDATION_REJECTED at s7, exit 3
```

Recoveries never change the result status; they are listed in `recoveries` and in the run's event log.

Discover a capability with a model. Put a key for any supported provider in `.env`; the free Google AI Studio tier is enough:

```bash
# .env
HANDSOFF_LLM_PROVIDER=google
GEMINI_API_KEY=...            # https://aistudio.google.com/apikey
```

Other providers: `anthropic` (`ANTHROPIC_API_KEY`), `openai` (`OPENAI_API_KEY`), `groq` (`GROQ_API_KEY`), `openrouter` (`OPENROUTER_API_KEY`), `ollama` (local, no key), or `openai-compatible` with `HANDSOFF_LLM_BASE_URL`. With `HANDSOFF_LLM_PROVIDER` empty the CLI uses whichever key it finds, and `--provider` overrides both. `HANDSOFF_MODEL` overrides the provider's default model (`claude-opus-5`, `gemini-3.8-flash`; the others need it set). The Google preset paces requests to the free tier's five per minute; the newest Flash models also cap the free tier at about 20 requests a day, which one discovery run can exhaust. The browser is headed so you can watch:

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

Browse runs and capabilities in the console. In one terminal serve the API, in another start the console dev server, then open http://localhost:5173:

```bash
pnpm serve       # read API on http://127.0.0.1:4000 over ./data
```

```bash
pnpm console     # Vite dev server on :5173, proxies /api to :4000
```

Runs show their result, step reports and a timeline with screenshots; capabilities show inputs, outputs, steps with every locator strategy, conditions and the raw artifact. To serve a built console from the API instead, run `pnpm --filter @handsoff/operator-console build` once and restart `pnpm serve`.

Checks:

```bash
pnpm test               # schema, resolver, classifier, compiler, planner, API and mock-app tests; no browser, no API key
pnpm test:integration   # real headless Chromium against the in-process mock app: replay, discover → compile → replay, and every chaos mode; no API key
pnpm typecheck
pnpm lint
```
