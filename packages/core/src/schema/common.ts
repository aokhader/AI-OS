import { z } from 'zod';

/** Kebab-case identifier: capability ids, vendor product ids, variant ids, condition ids, step ids. */
export const KebabIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/, 'must be kebab-case: lowercase letters, digits and hyphens');

/** Parameter names as the model and the caller use them. */
export const ParamNameSchema = z
  .string()
  .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, 'must be an identifier: letters, digits and underscores');

/** Outcome codes, failure kinds and escalation causes. */
export const CodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'must be SCREAMING_SNAKE_CASE');

export const IsoDateTimeSchema = z.iso.datetime();

/** A route path, possibly with :param segments or globs. */
export const RoutePathSchema = z.string().startsWith('/', 'must start with /');

export const RunIdSchema = z
  .string()
  .regex(/^run_\d{8}_\d{6}_[0-9a-f]{4}$/, 'must look like run_YYYYMMDD_HHMMSS_xxxx');
