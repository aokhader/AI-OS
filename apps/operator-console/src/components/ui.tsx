import type { ReactNode } from 'react';

/** 03 §5: status is conveyed by text as well as colour. */
const TONES: Record<string, string> = {
  success: 'bg-emerald-100 text-emerald-900 ring-emerald-300',
  compiled: 'bg-emerald-100 text-emerald-900 ring-emerald-300',
  outcome: 'bg-amber-100 text-amber-900 ring-amber-300',
  failure: 'bg-rose-100 text-rose-900 ring-rose-300',
  gave_up: 'bg-rose-100 text-rose-900 ring-rose-300',
  limit: 'bg-rose-100 text-rose-900 ring-rose-300',
  aborted: 'bg-rose-100 text-rose-900 ring-rose-300',
  escalated: 'bg-sky-100 text-sky-900 ring-sky-300',
  awaiting_operator: 'bg-sky-100 text-sky-900 ring-sky-300',
  human: 'bg-sky-100 text-sky-900 ring-sky-300',
  running: 'bg-neutral-100 text-neutral-700 ring-neutral-300',
};

export function StatusBadge({ status, detail }: { status: string; detail?: string | undefined }) {
  const tone = TONES[status] ?? 'bg-neutral-100 text-neutral-700 ring-neutral-300';
  return (
    <span
      className={`inline-flex items-baseline gap-1 rounded px-1.5 py-0.5 text-xs font-medium ring-1 ring-inset ${tone}`}
    >
      <span>{status}</span>
      {detail ? <code className="text-[11px] opacity-80">{detail}</code> : null}
    </span>
  );
}

export function Mono({ children }: { children: ReactNode }) {
  return <code className="mono text-[13px]">{children}</code>;
}

export function PageTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
      <h1 className="text-xl font-semibold tracking-tight">{children}</h1>
      {aside ? <div className="text-sm text-neutral-600">{aside}</div> : null}
    </div>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-6">
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-neutral-500">
        {title}
      </h2>
      {children}
    </section>
  );
}

export function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded border border-neutral-200 bg-white">
      <table className="w-full text-left text-sm">
        <thead className="bg-neutral-100 text-xs uppercase tracking-wide text-neutral-600">
          <tr>
            {head.map((h) => (
              <th key={h} className="px-3 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-100">{children}</tbody>
      </table>
    </div>
  );
}

export function Cell({ children, mono }: { children: ReactNode; mono?: boolean }) {
  return <td className={`px-3 py-2 align-top ${mono ? 'mono text-[13px]' : ''}`}>{children}</td>;
}

export function Loading({ what }: { what: string }) {
  return <p className="text-sm text-neutral-500">Loading {what}…</p>;
}

export function ErrorBox({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className="rounded border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900">
      <p className="font-medium">Could not load.</p>
      <p className="mono text-[13px]">{message}</p>
      <p className="mt-1 text-neutral-600">
        Is the runner serving? <Mono>pnpm handsoff serve</Mono>
      </p>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="rounded border border-dashed border-neutral-300 p-4 text-sm text-neutral-500">
      {children}
    </p>
  );
}

export function formatTime(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function formatDuration(startIso: string, endIso?: string | undefined): string {
  const start = new Date(startIso).getTime();
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end)) return '';
  const ms = Math.max(0, end - start);
  return ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 60_000)} min`;
}

export function Json({ value }: { value: unknown }) {
  return (
    <pre className="mono max-h-[32rem] overflow-auto rounded border border-neutral-200 bg-white p-3 text-[12px] leading-snug">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}
