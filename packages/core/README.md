# @handsoff/core

The domain of HandsOff: zod schemas for every artifact and record, the discovery and replay engines, the condition classifier, the policy gate, the redactor and the evidence recorder.

Must not depend on Playwright, a model SDK, Fastify or anything else runtime-specific. The planner protocol (tool schemas, prompt, rendering) lives here as pure zod and strings; provider packages translate it. Only zod and Node built-ins. The replay engine can reach a model only through the optional `RecoveryPlanner` port. See `docs/context/01-architecture.md` §3.

P0 contains the schemas and their tests. Engines arrive in P1–P6.
