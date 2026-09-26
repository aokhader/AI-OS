/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import {
  type A11yNode,
  type ActContext,
  type Action,
  type ActResult,
  type DialogInfo,
  type FrameInfo,
  MissingParamError,
  type ObserveOptions,
  resolveValue,
  type Surface,
  type SurfaceInfo,
  type SurfaceObservation,
} from '@handsoff/core';
import {
  type Browser,
  type BrowserContext,
  chromium,
  type Dialog,
  type ElementHandle,
  type Frame,
  type Page,
} from 'playwright';
import { type RawSnapshot, snapshotDocument } from './snapshot.js';

export interface PlaywrightSurfaceOptions {
  /** Headed by default so an operator can take over the window (D-012). */
  headless?: boolean | undefined;
  slowMo?: number | undefined;
  viewport?: { width: number; height: number } | undefined;
  /** For example the x-handsoff-chaos header the mock app honours. */
  extraHTTPHeaders?: Record<string, string> | undefined;
  actionTimeoutMs?: number | undefined;
}

class StaleRefError extends Error {
  override readonly name = 'StaleRefError';
}

const DIALOG_REFS = { dialog: 'dialog', ok: 'dialog-ok', cancel: 'dialog-cancel' } as const;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The walker travels to the page as source text. Transpilers may wrap the function expressions
 * inside it with helpers that only exist in Node (esbuild's `__name` under tsx), so the wrapper
 * defines a no-op `__name` in scope before invoking the walker. Under vitest no helper is emitted
 * and the definition is harmless. Playwright evaluates a string as an expression and does not call
 * a resulting function, so the call and its argument are part of the expression.
 */
const SNAPSHOT_SOURCE = snapshotDocument.toString();

function snapshotExpression(start: number): string {
  return `(function () {
  const __name = (fn) => fn;
  return (${SNAPSHOT_SOURCE})(${JSON.stringify({ start })});
})()`;
}

function refLookupExpression(ref: string): string {
  return `(window.__handsoff_refs ? window.__handsoff_refs[${JSON.stringify(ref)}] : undefined)`;
}

function framePathOf(frame: Frame): string[] {
  const path: string[] = [];
  let current: Frame | null = frame;
  for (;;) {
    const parent: Frame | null = current.parentFrame();
    if (!parent) break;
    const name = current.name() || `frame${parent.childFrames().indexOf(current)}`;
    path.unshift(name);
    current = parent;
  }
  return path;
}

function dialogKind(type: string): DialogInfo['kind'] {
  return type === 'confirm' || type === 'prompt' || type === 'alert' ? type : 'modal';
}

function refOf(action: Action): string {
  switch (action.kind) {
    case 'click':
    case 'type':
    case 'select':
    case 'extract':
      if ('ref' in action.target) return action.target.ref;
      throw new StaleRefError('action target is a TargetSpec; resolve it to a ref first');
    default:
      throw new StaleRefError(`${action.kind} has no target`);
  }
}

export async function createPlaywrightSurface(
  options: PlaywrightSurfaceOptions = {},
): Promise<PlaywrightSurface> {
  const browser = await chromium.launch({
    headless: options.headless ?? false,
    slowMo: options.slowMo ?? 0,
  });
  const context = await browser.newContext({
    viewport: options.viewport ?? { width: 1280, height: 900 },
    ...(options.extraHTTPHeaders ? { extraHTTPHeaders: options.extraHTTPHeaders } : {}),
  });
  const page = await context.newPage();
  return new PlaywrightSurface(browser, context, page, options);
}

/**
 * `Surface` over Playwright + Chromium. Observation walks every frame with the in-page snapshot
 * script; acting uses the element handles the script left behind for the refs of the latest
 * observation. Target resolution is not here: it is a pure function in core.
 */
export class PlaywrightSurface implements Surface {
  private readonly refFrames = new Map<string, Frame>();
  private pendingDialog: Dialog | undefined;
  /** Observations in flight when a dialog opens; see raceDialog(). */
  private readonly dialogWaiters = new Set<() => void>();
  private lastNodes: A11yNode[] = [];
  private lastFrames: FrameInfo[] = [];
  private lastTitle = '';
  private readonly actionTimeout: number;

  constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    readonly page: Page,
    options: PlaywrightSurfaceOptions,
  ) {
    this.actionTimeout = options.actionTimeoutMs ?? 10_000;
    page.on('dialog', (dialog) => {
      this.pendingDialog = dialog;
      for (const wake of this.dialogWaiters) wake();
      this.dialogWaiters.clear();
    });
  }

  /**
   * Script evaluation blocks for as long as a native dialog is open, so any snapshot that is
   * running when one appears would never return. Race it against the dialog event instead.
   */
  private async raceDialog<T>(work: () => Promise<T>): Promise<T | 'dialog'> {
    if (this.pendingDialog) return 'dialog';
    let wake: () => void = () => undefined;
    const opened = new Promise<'dialog'>((resolve) => {
      wake = () => resolve('dialog');
    });
    this.dialogWaiters.add(wake);
    try {
      const pending = work();
      pending.catch(() => undefined); // if the dialog wins, the evaluation settles later; never unhandled
      return await Promise.race([pending, opened]);
    } finally {
      this.dialogWaiters.delete(wake);
    }
  }

  info(): SurfaceInfo {
    return { kind: 'legacy-web', name: 'playwright-chromium' };
  }

  async observe(options: ObserveOptions = {}): Promise<SurfaceObservation> {
    const at = new Date().toISOString();

    // Script execution is blocked while a native dialog is open; report it on top of the last
    // snapshot. The same applies when the dialog opens while the snapshot is being taken.
    const snapshot = await this.raceDialog(() => this.snapshotAll());
    const dialog = this.pendingDialog;
    if (snapshot === 'dialog' || dialog) {
      const d = dialog as Dialog;
      return {
        at,
        url: this.page.url(),
        title: this.lastTitle,
        frames: this.lastFrames,
        nodes: [...this.lastNodes, ...this.dialogNodes(d)],
        dialogs: [{ kind: dialogKind(d.type()), text: d.message() }],
      };
    }

    const { nodes, frames, title } = snapshot;
    this.lastNodes = nodes;
    this.lastFrames = frames;
    this.lastTitle = title;

    const obs: SurfaceObservation = {
      at,
      url: this.page.url(),
      title,
      frames,
      nodes,
      dialogs: [],
    };
    if (options.screenshot ?? true) {
      obs.screenshotPng = await this.page.screenshot({ type: 'png' });
    }
    return obs;
  }

  /** Walks every frame with the in-page script and re-registers the refs it handed out. */
  private async snapshotAll(): Promise<{ nodes: A11yNode[]; frames: FrameInfo[]; title: string }> {
    await this.settle();
    const nodes: A11yNode[] = [];
    const frames: FrameInfo[] = [];
    this.refFrames.clear();
    let counter = 0;
    for (const frame of this.page.frames()) {
      const framePath = framePathOf(frame);
      const raw = await this.evaluateSnapshot(frame, counter);
      if (!raw) continue;
      const offset = await this.frameOffset(frame);
      counter += raw.count;
      for (const n of raw.nodes) {
        nodes.push({
          ref: n.ref,
          role: n.role,
          name: n.name,
          ...(n.value !== undefined ? { value: n.value } : {}),
          states: n.states,
          bbox: { x: n.bbox.x + offset.x, y: n.bbox.y + offset.y, w: n.bbox.w, h: n.bbox.h },
          framePath,
          path: n.path,
          ...(n.parentRef ? { parentRef: n.parentRef } : {}),
        });
        this.refFrames.set(n.ref, frame);
      }
      frames.push({ framePath, url: raw.url, title: raw.title });
    }
    const title = await this.page.title().catch(() => '');
    return { nodes, frames, title };
  }

  async act(action: Action, context: ActContext): Promise<ActResult> {
    const timeout = this.actionTimeout;
    try {
      switch (action.kind) {
        case 'click': {
          const ref = refOf(action);
          if (await this.clickDialogButton(ref))
            return { ok: true, detail: 'native dialog handled' };
          const el = await this.handleFor(ref);
          await el.click({ timeout });
          return { ok: true };
        }
        case 'type': {
          const value = resolveValue(action.value, context.values);
          const el = await this.handleFor(refOf(action));
          if (action.clear ?? true) await el.fill(value, { timeout });
          else {
            await el.focus();
            await this.page.keyboard.type(value);
          }
          return { ok: true };
        }
        case 'select': {
          const value = resolveValue(action.value, context.values);
          const el = await this.handleFor(refOf(action));
          try {
            await el.selectOption({ label: value }, { timeout });
          } catch {
            await el.selectOption(value, { timeout });
          }
          return { ok: true };
        }
        case 'press':
          await this.page.keyboard.press(action.key);
          return { ok: true };
        case 'navigate': {
          const url = new URL(resolveValue(action.url, context.values), context.baseUrl).toString();
          await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout });
          return { ok: true };
        }
        case 'wait':
          await this.page.waitForTimeout(action.ms ?? 500);
          return { ok: true };
        case 'extract':
          return { ok: true, detail: 'extraction is read from the observation by the engine' };
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      if (err instanceof MissingParamError) return { ok: false, reason: 'MISSING_PARAM', detail };
      if (err instanceof StaleRefError) return { ok: false, reason: 'STALE_REF', detail };
      return {
        ok: false,
        reason: action.kind === 'navigate' ? 'NAVIGATION_FAILED' : 'ACTION_FAILED',
        detail,
      };
    }
  }

  async close(): Promise<void> {
    await this.context.close().catch(() => undefined);
    await this.browser.close().catch(() => undefined);
  }

  // ---- internals ----------------------------------------------------------------------------

  private async settle(): Promise<void> {
    for (const frame of this.page.frames()) {
      await frame.waitForLoadState('domcontentloaded', { timeout: 3_000 }).catch(() => undefined);
    }
  }

  private async evaluateSnapshot(frame: Frame, start: number): Promise<RawSnapshot | undefined> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return (await frame.evaluate(snapshotExpression(start))) as RawSnapshot;
      } catch {
        if (frame.isDetached()) return undefined;
        await sleep(150);
      }
    }
    return undefined;
  }

  private async frameOffset(frame: Frame): Promise<{ x: number; y: number }> {
    if (!frame.parentFrame()) return { x: 0, y: 0 };
    const element = await frame.frameElement().catch(() => null);
    if (!element) return { x: 0, y: 0 };
    const box = await element.boundingBox().catch(() => null);
    await element.dispose();
    return box ? { x: box.x, y: box.y } : { x: 0, y: 0 };
  }

  private async handleFor(ref: string): Promise<ElementHandle<Element>> {
    const frame = this.refFrames.get(ref);
    if (!frame) throw new StaleRefError(`ref ${ref} is not part of the latest observation`);
    const handle = await frame.evaluateHandle(refLookupExpression(ref));
    const element = handle.asElement();
    if (!element) {
      await handle.dispose();
      throw new StaleRefError(`ref ${ref} is no longer attached to the page`);
    }
    return element as ElementHandle<Element>;
  }

  private dialogNodes(dialog: Dialog): A11yNode[] {
    const zero = { x: 0, y: 0, w: 0, h: 0 };
    const nodes: A11yNode[] = [
      {
        ref: DIALOG_REFS.dialog,
        role: 'dialog',
        name: dialog.message(),
        states: [],
        bbox: zero,
        framePath: [],
        path: 'dialog',
      },
      {
        ref: DIALOG_REFS.ok,
        role: 'button',
        name: 'OK',
        states: [],
        bbox: zero,
        framePath: [],
        path: 'dialog/button[1]',
        parentRef: DIALOG_REFS.dialog,
      },
    ];
    if (dialog.type() !== 'alert') {
      nodes.push({
        ref: DIALOG_REFS.cancel,
        role: 'button',
        name: 'Cancel',
        states: [],
        bbox: zero,
        framePath: [],
        path: 'dialog/button[2]',
        parentRef: DIALOG_REFS.dialog,
      });
    }
    return nodes;
  }

  private async clickDialogButton(ref: string): Promise<boolean> {
    const dialog = this.pendingDialog;
    if (!dialog) return false;
    if (ref === DIALOG_REFS.ok) {
      this.pendingDialog = undefined;
      await dialog.accept();
      return true;
    }
    if (ref === DIALOG_REFS.cancel) {
      this.pendingDialog = undefined;
      await dialog.dismiss();
      return true;
    }
    return false;
  }
}
