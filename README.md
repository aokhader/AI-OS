# HandsOff

Computer-use automation for legacy banking software. An LLM figures out how to complete a goal in a UI once; the run is compiled into a typed, versioned, replayable **capability**; from then on the capability replays deterministically with no model in the loop, explicit error handling, safety guardrails, and a human escalation path that hands over the live browser session.

Take-home assessment for interface.ai. The brief is at [docs/description.md](docs/description.md). The project's working knowledge base, read at the start of every session, is [docs/context/](docs/context/README.md).

> Status: phase P1 complete. Deterministic replay of a hand-written capability works end to end against the mock app; LLM discovery arrives in P2 and the design write-up (`/REPORT.md`) in P8. See [docs/context/04-roadmap.md](docs/context/04-roadmap.md).

## Layout

```
packages/core                schemas, engines, policy, redaction (no runtime deps)
packages/surface-playwright  Surface implementation over Playwright        (P1)
packages/llm-anthropic       Planner implementation over the Anthropic SDK (P2)
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

Checks:

```bash
pnpm test               # schema, resolver, classifier and mock-app tests; no browser, no API key
pnpm test:integration   # real headless Chromium against the in-process mock app; no API key
pnpm typecheck
pnpm lint
```
