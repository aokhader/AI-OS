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
  /** Masked when bound to a sensitive parameter; never emitted for password fields. */
  value: z.string().optional(),
  states: z.array(z.string()),
  /** Page coordinates: frame offsets are already applied. */
  bbox: BboxSchema,
  framePath: z.array(z.string().min(1)),
  /** Structural path inside its frame, e.g. "form[1]/table[1]/tr[2]/td[2]/input[1]". Table sections are transparent. */
  path: z.string().min(1),
  parentRef: z.string().min(1).optional(),
  /** Web surfaces: the resolved action URL of the form a control belongs to. The policy gate reads it. */
  formAction: z.string().min(1).optional(),
});
export type A11yNode = z.infer<typeof A11yNodeSchema>;

export const DialogInfoSchema = z.strictObject({
  kind: z.enum(['alert', 'confirm', 'prompt', 'modal']),
  text: z.string(),
  ref: z.string().min(1).optional(),
});
export type DialogInfo = z.infer<typeof DialogInfoSchema>;

export const FrameInfoSchema = z.strictObject({
  framePath: z.array(z.string().min(1)),
  url: z.string(),
  title: z.string(),
});
export type FrameInfo = z.infer<typeof FrameInfoSchema>;

export const ScreenshotRefSchema = z.strictObject({
  path: z.string().min(1),
});
export type ScreenshotRef = z.infer<typeof ScreenshotRefSchema>;

export const ObservationSchema = z.strictObject({
  at: IsoDateTimeSchema,
  /** Top document URL. Inside a frameset this stays put while frames navigate; see frames. */
  url: z.string().optional(),
  title: z.string(),
  /** Every frame in the page including the top document (framePath []), with its own URL and title. */
  frames: z.array(FrameInfoSchema),
  nodes: z.array(A11yNodeSchema),
  dialogs: z.array(DialogInfoSchema),
  screenshot: ScreenshotRefSchema,
  /** Stable hash of the semantically relevant parts, for change detection. */
  digest: z.string().min(1),
});
export type Observation = z.infer<typeof ObservationSchema>;
