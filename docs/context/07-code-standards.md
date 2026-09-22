# 07 · Code Standards

Status: draft · Last updated: 2026-09-21

Skeleton. Headings are final; each holds its intent and a `TODO` until written in full during P0.

## 1. TypeScript configuration

Base `tsconfig.base.json` shared by every package: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `module: NodeNext`, `target: ES2022`. Each package extends it. No `skipLibCheck` in packages we own.

TODO

## 2. Module boundaries

The dependency rules from [01 §3](01-architecture.md#3-package-map-and-dependency-rules). `core` imports zod and Node built-ins only. Adapters import `core`. Apps import adapters and `core`. `legacy-bank` imports nothing from the workspace. Enforced by review and by a small vitest that parses each `package.json`.

TODO

## 3. Errors as data

Across every seam, functions return discriminated unions (`Verdict`, `Resolution`, `ReplayResult`, classifier decisions). `throw` is for programmer errors and truly unrecoverable I/O. Never catch and convert an exception into a business status without recording the original in the event log.

TODO

## 4. Validation at boundaries

Every value that enters from outside a package (CLI args, HTTP bodies, files on disk, model tool inputs, page content) is parsed with the zod schema first. Inside a package, trust the types.

TODO

## 5. Naming

Files `kebab-case.ts`; types and schemas `PascalCase` with schemas suffixed `Schema`; functions and variables `camelCase`; outcome codes, failure kinds and escalation causes `SCREAMING_SNAKE`; step ids `s1`, `s2`; run ids `run_<yyyymmdd>_<hhmmss>_<4hex>`; event `type` values `snake_case`.

TODO

## 6. Logging and events

pino, structured, one object per line. The run event log is the only log of record for a run; process-level logs are for startup and crashes. Redaction runs before serialisation, never after. No `console.log` outside the CLI's user-facing output.

TODO

## 7. Tests

vitest. Unit tests sit next to the code as `*.test.ts`. Fixtures (saved observations, artifacts, policies) live in `packages/core/test/fixtures/`. Integration tests that drive the mock app live in `apps/runner/test/` and run headless. What must be tested is listed in [06 §8](06-ai-workflow-rules.md#8-testing-expectations).

TODO

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

TODO

## 9. React conventions

Function components, hooks only, TanStack Query for all server data, no global state store. Components under `src/screens/<route>/` and `src/components/`. Tailwind utility classes; no CSS modules. Status colours come from one `status.ts` map.

TODO

## 10. Formatting and lint

Biome with the default recommended rules plus `noExplicitAny: error`. `pnpm lint` and `pnpm format` at the root. CI is not set up for this take-home; run both before every commit.

TODO
