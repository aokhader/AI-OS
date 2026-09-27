# HandsOff

Computer-use automation for legacy banking software. An LLM figures out how to complete a goal in a UI once; the run is compiled into a typed, versioned, replayable **capability**; from then on the capability replays deterministically with no model in the loop, explicit error handling, safety guardrails, and a human escalation path that hands over the live browser session and takes it back.

Take-home assessment for interface.ai: the brief is [docs/description.md](docs/description.md), the design write-up is [REPORT.md](REPORT.md), and the evidence of real runs is in [evidence/](evidence/). The project's working knowledge base (architecture, data model, decision log, roadmap) is [docs/context/](docs/context/README.md).

## Setup

Requirements: Node 22, pnpm 11, and Chromium for Playwright. No API key is needed for anything except discovering a new capability with a model and the assisted fallback.

```bash
pnpm install
pnpm --filter @handsoff/surface-playwright exec playwright install chromium
cp .env.example .env
```

`.env` is git-ignored and [`.env.example`](.env.example) lists every variable by name. The ones that matter: `LEGACY_BANK_USER` and `LEGACY_BANK_PASS` (synthetic sign-in for the mock app; the defaults work), `HANDSOFF_HEADLESS` (`false` by default so you can watch the browser and take over), and, only for discovery, a provider key such as `GEMINI_API_KEY` with `HANDSOFF_LLM_PROVIDER=google`. Policy lives in [config/policy.json](config/policy.json).

## Running without live services

Everything except discovery runs offline against the mock legacy bank app in this repository. Start it, then replay a saved capability in a second terminal:

```bash
pnpm dev          # ACME CoreTeller for "First Example Credit Union" on http://localhost:4100 (sign in: teller / value of LEGACY_BANK_PASS)
```

```bash
pnpm handsoff replay --capability get-member-savings-balance --param memberId=10001
```

Exit code 0 and `{"savingsBalance": 1250.75}` on stdout; the run folder with masked screenshots, `events.jsonl` and `result.json` is printed on stderr. When piping stdout into another tool, use `pnpm --silent handsoff …` so pnpm's own failure line does not follow the JSON on a non-zero exit. An unknown member is a business outcome, not a failure:

```bash
pnpm handsoff replay --capability get-member-savings-balance --param memberId=99999   # outcome MEMBER_NOT_FOUND at s2, exit 3
```

Discovery itself can also run without a model, following a script of targets (this is what the integration tests do):

```bash
pnpm handsoff discover --goal "Look up member {memberId} and return the current balance of the Savings account" --param memberId=10001 --sensitive memberId --id get-member-savings-balance-scripted --outcome "MEMBER_NOT_FOUND=No matching member" --scripted data/discovery-scripts/get-member-savings-balance.json
```

The test suites need no key either: `pnpm test` (unit) and `pnpm test:integration` (real headless Chromium against an in-process mock app).

## Demo path

1. Put a key in `.env`. The free Google AI Studio tier is enough:

   ```bash
   # .env
   HANDSOFF_LLM_PROVIDER=google
   GEMINI_API_KEY=...            # https://aistudio.google.com/apikey
   ```

   Other providers: `anthropic` (`ANTHROPIC_API_KEY`), `openai` (`OPENAI_API_KEY`), `groq` (`GROQ_API_KEY`), `openrouter` (`OPENROUTER_API_KEY`), `ollama` (local, no key), or `openai-compatible` with `HANDSOFF_LLM_BASE_URL`. With `HANDSOFF_LLM_PROVIDER` empty the CLI uses whichever key it finds; `--provider` overrides both. `HANDSOFF_MODEL` overrides the provider's default model (`claude-opus-5`, `gemini-3.8-flash`; the others need it set). The Google preset paces requests to the free tier's five per minute; the newest Flash models also cap the free tier at about 20 requests a day, which one discovery run can exhaust, so `HANDSOFF_MODEL=gemini-3.5-flash-lite` is a good second choice.

2. Run the agent on a goal (with `pnpm dev` running). The browser is headed so you can watch:

   ```bash
   pnpm handsoff discover --goal "Look up member {memberId} and return the current balance of the Savings account" --param memberId=10001 --sensitive memberId --describe "memberId=Member number as printed on the member card" --id get-member-savings-balance --outcome "MEMBER_NOT_FOUND=No matching member"
   ```

   The run folder holds every observation, decision, policy check and action, the masked screenshots, and the model transcript with parameter values redacted. The compiled capability is written as the next version of `data/capabilities/get-member-savings-balance/`.

3. Replay the artifact it produced, with no model involved:

   ```bash
   pnpm handsoff replay --capability get-member-savings-balance --param memberId=10001
   ```

4. Keep a run as evidence:

   ```bash
   pnpm evidence:copy <runId> discovery-run
   ```

The write flow was discovered the same way. Its submit classified risky, so discovering it asks the operator before that step: run it in a terminal, or pass `--operator approve-all`:

```bash
pnpm handsoff discover --goal "Open a new sub-account of type {accountType} with an initial deposit of {deposit} for member {memberId} and return the confirmation number" --name "Open a sub-account for a member" --param memberId=10001 --param accountType=Checking --param deposit=25.00 --sensitive memberId --id open-sub-account --outcome "MEMBER_NOT_FOUND=No matching member" --outcome "VALIDATION_REJECTED=Please correct the errors below."
```

## Runtime conditions

Inject a condition into the mock app and watch the classifier answer it (each mode fires once per browser; see [docs/context/02](docs/context/02-tech-stack-and-data-model.md#configuration-and-environment)):

```bash
pnpm handsoff replay --capability get-member-savings-balance --param memberId=10001 --chaos session-expiry   # success, one rebootstrap recovery, s1 and s2 at two attempts
```

```bash
pnpm handsoff replay --capability get-member-savings-balance --param memberId=10001 --chaos interstitial     # success, one dismissed System notice
```

```bash
pnpm handsoff replay --capability get-member-savings-balance --param memberId=10001 --chaos error            # failure APP_ERROR at s2 with screenshot and snapshot
```

Other modes: `not-found`, `slow` (a busy page waited out with wait-retry), `validation` (the sub-account submit rejected once) and `relabel` (the search button renamed and moved, so no recorded locator finds it). Recoveries never change the result status; they are listed in `recoveries` and in the run's event log.

## Policy, risk and confirmation

Every action passes the policy gate in [config/policy.json](config/policy.json) before it executes: the action kind, the origin and route of a navigation, and the live risk of the control (button text, form action, route). The second capability, `open-sub-account`, exercises the write path: its submit classified risky at discovery, so the artifact carries `risk: risky, confirm: operator` on s7, and every replay pauses there for an operator. In a terminal the CLI asks you (`--operator tty`, the default); unattended, the run stops before the step with nothing committed:

```bash
pnpm handsoff approve --capability open-sub-account      # the reviewer's step; a risky step on a draft capability is POLICY_BLOCKED
```

```bash
pnpm handsoff replay --capability open-sub-account --param memberId=10001 --param accountType=Checking --param deposit=40.00 --operator none          # failure ESCALATION_ABANDONED at s7, side effects none, exit 1
```

```bash
pnpm handsoff replay --capability open-sub-account --param memberId=10001 --param accountType=Checking --param deposit=40.00 --operator approve-all   # success with a confirmation number, side effects committed
```

`--operator approve-all` stands in for an operator who pre-approved the run; add `--chaos validation` to see the submit rejected once (`outcome VALIDATION_REJECTED` at s7, exit 3). Navigations outside the allowlist are refused twice: by the gate, which tells the model or fails the replay with `POLICY_BLOCKED`, and by the browser layer, which answers any request to another origin with a block page ([evidence/discovery-policy-blocked](evidence/discovery-policy-blocked) shows both). Sensitive parameter values never reach the model or the disk: the model sees `{memberId}`, everything persisted carries `«memberId#sha256:…»`, screenshots are painted over wherever the value shows, and sensitive outputs are masked in `result.json` while the caller gets the real value on stdout.

## Handing the session to a person

With `--operator console` the run serves the console API itself; open the console, claim the escalation, and the browser window is yours:

```bash
pnpm handsoff replay --capability open-sub-account --param memberId=10001 --param accountType=Checking --param deposit=40.00 --operator console   # pauses at s7; claim it in the console
```

```bash
pnpm console     # http://localhost:5173 → Escalations → claim → click Open Account in the browser window → Resume automation
```

Every click, change and Enter you make while you hold control is recorded as a step with a real locator, the run continues from the step checkpoints ("where did the person leave the page?"), and the result carries an `escalation` block with the cause, the resolution and your actions. *Approve step* lets automation run the step itself, *Mark complete* makes it verify the success condition and read the outputs from the page, *Abort* ends the run. A failure automation cannot fix (`TARGET_NOT_FOUND`, an error page) escalates the same way when an operator is attached and `policy.escalateOn` allows it; unattended, it stays a failure. In a plain terminal, `--operator tty` offers the same choices as prompts. `pnpm demo:handoff` runs the whole loop with a script standing in for the person at the window; that is how [evidence/replay-escalation-handoff](evidence/replay-escalation-handoff) was made.

## One capability, two tenants

Variant B of the mock app is the same vendor product configured by another institution: other branding, `Find` and `Open` instead of `Search` and `View`, `Member Number` instead of `Member #`, a renamed main frame and reordered account columns. Start it on `:4101` and replay the capability recorded on A:

```bash
pnpm dev:b       # Sample Federal Credit Union on http://localhost:4101
```

```bash
pnpm handsoff replay --capability get-member-savings-balance --param memberId=10001 --base-url http://localhost:4101 --variant sample-federal-cu   # success; every step resolves by its first strategy
```

The app profile ([data/app-profiles/acme-coreteller.json](data/app-profiles/acme-coreteller.json)) carries each variant's fingerprint and overrides (label, route and frame maps, extra detectors); a capability can add per-step replacements for a variant. The runner fingerprints the session once the entry page is open, rewrites the capability in memory, and records what it applied in a `variant` event. Without `--variant` it uses whichever single variant matches; a page that matches none, or a variant the page contradicts, is `DRIFT_SUSPECTED` before any step runs.

## Assisted fallback

The one model call allowed on the replay path. With `--assisted` (or `policy.assistedFallback.enabled`), a step whose target cannot be found, or whose checkpoint does not hold, gets one proposal from the configured model: the proposal must target an element of the page it was shown, passes the same policy gate, is refused if it is risky, and is re-verified against the step's own checkpoint before the run continues. At most `maxPerRun` proposals per run; if it fails, the original failure stands. It needs a provider key like discovery does:

```bash
pnpm handsoff replay --capability get-member-savings-balance --param memberId=10001 --chaos relabel --assisted   # success; recoveries: one assisted proposal, step s2 marked drift
```

Without `--assisted` the same run is `failure TARGET_NOT_FOUND at s2`, and no model is involved.

## Console

Browse runs, capabilities and escalations. In one terminal serve the API, in another start the console dev server, then open http://localhost:5173:

```bash
pnpm serve       # read API on http://127.0.0.1:4000 over ./data
```

```bash
pnpm console     # Vite dev server on :5173, proxies /api and /ws to :4000
```

Runs show their result, step reports and a timeline with screenshots; capabilities show inputs, outputs, steps with every locator strategy, conditions and the raw artifact; escalations are listed with their state, and can be claimed only from the process that owns the browser (`--operator console`). To serve a built console from the API instead, run `pnpm --filter @handsoff/operator-console build` once and restart `pnpm serve`.

## Evidence

Each folder under [evidence/](evidence/) is a run folder copied verbatim: `run.json`, `events.jsonl` (every observation, decision, policy check, action, condition, recovery, control transfer and human action), `result.json`, masked screenshots under `steps/`, redacted snapshots where the run stopped, and the model transcript for discovery runs. Nothing under `evidence/` is ever edited; a wrong run is replaced by a fresh one.

| Folder | What it shows |
|---|---|
| `discovery-run` | Real model-driven discovery (Gemini 3.5 Flash Lite): goal → 3 tool calls → compiled `get-member-savings-balance` v4 |
| `discovery-run-open-sub-account` | Real discovery of the write flow; the risky submit confirmed through the policy gate and compiled `risky` with `confirm: operator` |
| `discovery-policy-blocked` | A scripted run trying `/admin/users`, an external site and an external link: blocked by the gate, then by the browser layer |
| `replay-success` | Deterministic replay to the balance; sensitive output masked in `result.json` |
| `replay-member-not-found` | A bad input as a business outcome, `MEMBER_NOT_FOUND` at s2 |
| `replay-session-expiry` | Injected session expiry recovered by signing in again and re-running from the entry, attempts counted |
| `replay-confirm-required` | The risky submit stops an unattended run before it executes, `ESCALATION_ABANDONED`, nothing committed |
| `replay-escalation-handoff` | Automation pauses, a person claims through the console API, clicks the button in the same session, hands back, the checkpoint scan resumes, `escalation` block in the result |
| `replay-variant-b` | The capability recorded on tenant A succeeding on tenant B through the profile's overrides |
| `replay-assisted-fallback` | A relabelled control no locator finds; one gated model proposal, re-verified, run continues |
| `capability.*.json` | The two compiled artifacts as replayed |

## Checks

```bash
pnpm test               # schema, resolver, classifier, compiler, policy gate, redaction, control owner, checkpoint scan, human steps, variants, recovery planner, planner, API and mock-app tests; no browser, no API key
pnpm test:integration   # real headless Chromium against the in-process mock app: replay, discover → compile → replay, every chaos mode, the gate at both layers, masking, every escalation path including the live console API, both tenants, and assisted fallback with a scripted planner; no API key
pnpm typecheck
pnpm lint
```

## Layout

```
packages/core                schemas, engines, classifier, policy gate, redaction, store (zod + Node only)
packages/surface-playwright  Surface over Playwright: observe, act, mask, block, capture human actions
packages/llm-anthropic       Planner over the Anthropic SDK
packages/llm-openai          Planner over the OpenAI protocol: Google AI Studio, Groq, OpenRouter, Ollama, any compatible endpoint
apps/runner                  `handsoff` CLI: discover, replay, approve, serve; embedded console API
apps/operator-console        Vite + React operator console
apps/legacy-bank             mock legacy credit-union app, two tenants, chaos injection
config/policy.json           allowlist, risk patterns, budgets, escalation and assisted-fallback switches
data/app-profiles/           per vendor product: sign-in routine, shared detectors, variants
data/capabilities/           compiled artifacts, one folder per capability, one file per version
docs/context/                architecture, data model, decisions, roadmap, tracker
```
