/**
 * Writes the reviewable JSON Schema for a capability artifact to packages/core/schema/.
 * Run with `pnpm schema:export`. Refinements (cross-field rules) are enforced by zod only and
 * are listed in the schema description so reviewers know what the JSON Schema does not check.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { AppProfileSchema, CapabilitySchema, PolicySchema } from '../src/schema/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, '../schema');
mkdirSync(outDir, { recursive: true });

const targets = [
  ['capability.schema.json', CapabilitySchema, 'HandsOff capability artifact'],
  ['app-profile.schema.json', AppProfileSchema, 'HandsOff app profile'],
  ['policy.schema.json', PolicySchema, 'HandsOff policy'],
] as const;

for (const [file, schema, title] of targets) {
  const json = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    unrepresentable: 'any',
    reused: 'ref',
  });
  const out = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title,
    description:
      'Generated from packages/core by `pnpm schema:export`. Cross-field rules (step ids, bindings, ' +
      'condition roles, risky steps) are checked by the zod schema, not by this JSON Schema.',
    ...json,
  };
  writeFileSync(path.join(outDir, file), `${JSON.stringify(out, null, 2)}\n`);
  console.log(`wrote ${path.relative(process.cwd(), path.join(outDir, file))}`);
}
