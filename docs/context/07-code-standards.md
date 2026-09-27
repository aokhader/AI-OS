# 07 · Code Standards

Status: stable · Last updated: 2026-09-26

## 1. TypeScript configuration

Base `tsconfig.base.json` shared by every package: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `verbatimModuleSyntax`, `module: NodeNext`, `target: ES2022`, `noEmit`. Each package extends it. `skipLibCheck` is on: third-party declaration files are not re-checked (vitest's benchmark dependency needs DOM types otherwise); our own code is fully strict. Relative imports use the `.js` extension, as Node ESM requires. The console alone uses `moduleResolution: Bundler` and `jsx: react-jsx` because Vite builds it.

Two consequences worth knowing. `exactOptionalPropertyTypes` means an optional field is spread in conditionally (`...(x ? { x } : {})`) rather than assigned `undefined`; the engines do this everywhere they build events and results. `noUncheckedIndexedAccess` means every array index and record lookup is `T | undefined` and is narrowed, which is why `steps[i]` reads are guarded and why the tests reach for `steps[0]?.` rather than asserting non-null.

## 2. Module boundaries

The dependency rules from [01 §3](01-architecture.md#3-package-map-and-dependency-rules). `core` imports zod and Node built-ins only. Adapters import `core`. Apps import adapters and `core`. `legacy-bank` imports nothing from the workspace. Enforced by review and by a small vitest that parses each `package.json`.

The two boundaries that carry the safety story: `core` has no model SDK, so "no model on the replay path" is a dependency fact, and the console imports only types from `core`, so the wire shape of the API is pinned in one file (`api/console.ts`) and the console can never reach the filesystem or the browser. Anything that must cross a boundary crosses it as a port interface in `core/ports/` (`Surface`, `Planner`, `RecoveryPlanner`, `Operator`, `Store`) with the adapter on the other side.

## 3. Errors as data

Across every seam, functions return discriminated unions (`Verdict`, `Resolution`, `ReplayResult`, classifier decisions). `throw` is for programmer errors and truly unrecoverable I/O. Never catch and convert an exception into a business status without recording the original in the event log.

The engines use two internal exceptions as control flow and nothing else: `Stop` carries a result-shaped reason (a failure, an outcome, or a stop status) to the outer loop, and the signals `RebootstrapSignal` and `HandBackSignal` tell the outer loop to restart or resume the flow. Neither escapes an engine. Anything else thrown inside a run becomes an `UNEXPECTED_STATE` failure whose observed text is the original error, so a bug is visible in the result rather than masked as a business outcome.

## 4. Validation at boundaries

Every value that enters from outside a package (CLI args, HTTP bodies, files on disk, model tool inputs, page content) is parsed with the zod schema first. Inside a package, trust the types.

The store validates every file it reads with the file's zod schema, so a hand-edited artifact fails loudly at load rather than somewhere in the resolver. The API validates ids before they touch a path and bodies before they touch the live controls. The planner adapters parse every tool call through the protocol's schemas and answer the model with a nudge when it does not parse. Variant overrides produce a capability that is parsed again before it runs.

## 5. Naming

Files `kebab-case.ts`; types and schemas `PascalCase` with schemas suffixed `Schema`; functions and variables `camelCase`; outcome codes, failure kinds and escalation causes `SCREAMING_SNAKE`; step ids `s1`, `s2`; run ids `run_<yyyymmdd>_<hhmmss>_<4hex>`; event `type` values `snake_case`.

Also: escalation ids are `<runId>-e<n>`, human steps are `h1`, `h2` within a run, discovery turns are `t1`, `t2` as step ids in the event log, bootstrap steps are `b1`, `b2` on the profile, and snapshot files are named after the step and the condition that produced them (`s2-session-expired.json`).

## 6. Logging and events

The run event log (`events.jsonl`, one validated `RunEvent` per line) is the only log of record for a run. Redaction runs before serialisation, never after: every event, snapshot, transcript line, escalation record and result goes through `redactJson`. The CLI writes a human-readable progress line per step, recovery, escalation and policy decision to stderr through the engine's `log` callback, and the result JSON to stdout, so a caller can pipe the result while a person reads the progress. pino was planned and not needed: nothing runs long enough to want process-level logging.

## 7. Tests

vitest. Unit tests sit next to the code as `*.test.ts`. Fixtures (saved observations, artifacts, policies) live in `packages/core/test/fixtures/`. Integration tests that drive the mock app live in `apps/runner/test/` and run headless. What must be tested is listed in [06 §8](06-ai-workflow-rules.md#8-testing-expectations).

As built, fixtures live next to the tests that use them: the classifier's captured snapshots under `packages/core/src/conditions/fixtures/`, discovery scripts under `data/discovery-scripts/`. Integration tests start the mock app in-process on a random port, copy the committed profiles and capabilities into a temporary data directory, and build any capability variant they need in memory (an approved copy, a broken target) rather than committing test-only artifacts. A test asserts on the result contract and on the event log, never on log lines.

## 8. Package layout

```
packages/<name>/
  src/
    index.ts            public exports only
    <area>/             one folder per concern (schema/, engine/, policy/, ...)
  test/
    fixtures/
  package.json
  tsconfig.json
  README.md             one paragraph: what it is, what it must not depend on
```

Core's areas as built: `schema/`, `ports/`, `engine/` (base, replay, discover, control, checkpoint, human, values, parsers), `conditions/` (predicate, classify, fixtures), `resolve/`, `compile/`, `policy/`, `planners/` (protocol, scripted, recovery), `variants/`, `store/`, `api/` (console wire types) and `redact.ts`. Unit tests sit beside their subject as `*.test.ts`; the `test/` folder is used only by the runner for integration tests.

## 9. React conventions

Function components, hooks only, TanStack Query for all server data, no global state store. Pages under `src/pages/`, shared pieces in `src/components/ui.tsx`, every fetch and mutation in `src/api.ts`. Tailwind utility classes; no CSS modules. Status colours come from the one tone map in `ui.tsx`. The WebSocket is one hook that invalidates queries; polling stays on as the fallback, so a dropped socket makes the console slower, never stale.

## 10. Formatting and lint

Biome with the default recommended rules plus `noExplicitAny: error`. `pnpm lint` and `pnpm format` at the root. CI is not set up for this take-home; run both before every commit, together with `pnpm typecheck`, `pnpm test` and `pnpm test:integration`. Generated JSON (`data/capabilities`, `data/runs`, `evidence`, the captured classifier fixtures) is excluded from Biome so a formatter never touches an artifact or evidence.
