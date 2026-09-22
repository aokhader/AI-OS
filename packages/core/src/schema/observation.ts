import { z } from 'zod';
import { IsoDateTimeSchema } from './common.js';

export const BboxSchema = z.strictObject({
  x: z.number(),
  y: z.number(),
  w: z.number().nonnegative(),
  h: z.number().nonnegative(),
});
export type Bbox = z.infer<typeof BboxSchema>;

/** One node of the flattened accessibility tree. Surface-agnostic by design (D-002). */
export const A11yNodeSchema = z.strictObject({
  /** "e12"; stable within one observation only. */
  ref: z.string().min(1),
  role: z.string().min(1),
  name: z.string(),
  /** Masked when bound to a sensitive parameter. */
  value: z.string().optional(),
  states: z.array(z.string()),
  bbox: BboxSchema,
  framePath: z.array(z.string().min(1)),
  parentRef: z.string().min(1).optional(),
});
export type A11yNode = z.infer<typeof A11yNodeSchema>;

export const DialogInfoSchema = z.strictObject({
  kind: z.enum(['alert', 'confirm', 'prompt', 'modal']),
  text: z.string(),
  ref: z.string().min(1).optional(),
});
export type DialogInfo = z.infer<typeof DialogInfoSchema>;

export const ScreenshotRefSchema = z.strictObject({
  path: z.string().min(1),
});
export type ScreenshotRef = z.infer<typeof ScreenshotRefSchema>;

export const ObservationSchema = z.strictObject({
  at: IsoDateTimeSchema,
  url: z.string().optional(),
  title: z.string(),
  nodes: z.array(A11yNodeSchema),
  dialogs: z.array(DialogInfoSchema),
  screenshot: ScreenshotRefSchema,
  /** Stable hash of the semantically relevant parts, for change detection. */
  digest: z.string().min(1),
});
export type Observation = z.infer<typeof ObservationSchema>;
