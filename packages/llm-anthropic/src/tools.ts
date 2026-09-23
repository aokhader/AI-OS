import type Anthropic from '@anthropic-ai/sdk';
import { plannerToolSpecs } from '@handsoff/core';

/**
 * The planner protocol's tool specs (core, D-030) in the Anthropic wire format. Every tool is
 * strict: the schemas are flat objects with `additionalProperties: false` (D-028).
 */
export function toolDefinitions(): Anthropic.Beta.BetaTool[] {
  return plannerToolSpecs().map((spec) => ({
    name: spec.name,
    description: spec.description,
    input_schema: spec.parameters as Anthropic.Beta.BetaTool['input_schema'],
    strict: true,
  }));
}
