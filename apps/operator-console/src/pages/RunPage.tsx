import type { DiscoveryResult, ReplayResult, RunEvent } from '@handsoff/core';
import { Link, useParams } from 'react-router';
import { runFileUrl, useRun } from '../api';
import {
  Cell,
  Empty,
  ErrorBox,
  formatDuration,
  formatTime,
  Json,
  Loading,
  Mono,
  PageTitle,
  Section,
  StatusBadge,
  Table,
} from '../components/ui';

function describeEvent(e: RunEvent): string {
  switch (e.type) {
    case 'observation':
      return `${e.title || '(untitled)'} · ${e.nodeCount} nodes${e.dialogCount ? ` · ${e.dialogCount} dialog(s)` : ''}${e.url ? ` · ${e.url}` : ''}`;
    case 'decision': {
      const d = e.decision;
      if (d.kind === 'tool') return `${d.action.kind} · ${d.intent}`;
      if (d.kind === 'resolve') return 'resolve target';
      if (d.kind === 'finish') return `finish · ${d.summary}`;
      return `${d.kind} · ${d.reason}`;
    }
    case 'policy_check':
      return `${e.action.kind} → ${e.verdict.kind}${e.verdict.kind === 'allow' ? ` (${e.verdict.risk})` : ` · ${e.verdict.rule}`}${e.mismatch ? ' · risk mismatch' : ''}`;
    case 'confirmation':
      return `${e.cause} → ${e.answer}${e.operatorId ? ` · ${e.operatorId}` : ''}`;
    case 'action':
      return `${e.action.kind} · ${e.durationMs} ms${e.resolvedBy !== undefined ? ` · strategy ${e.resolvedBy + 1}${e.candidateCount !== undefined ? ` of ${e.candidateCount} candidate(s)` : ''}` : ''}`;
    case 'condition':
      return `${e.conditionId} (${e.class ?? e.role}) ${e.matched ? 'matched' : 'not matched'}${e.code ? ` · ${e.code}` : ''}`;
    case 'recovery':
      return `${e.recovery.routine} attempt ${e.recovery.attempt} → ${e.recovery.outcome} · budget left ${e.budgetRemaining}`;
    case 'drift':
      return `baseline ${e.baseline.resolvedBy}/${e.baseline.candidateCount} → observed ${e.observed.resolvedBy}/${e.observed.candidateCount}`;
    case 'control_transfer':
      return `${e.from} → ${e.to}${e.cause ? ` · ${e.cause}` : ''}${e.operatorId ? ` · ${e.operatorId}` : ''}`;
    case 'human_action':
      return `${e.step.action.kind} · ${e.step.intent}`;
    case 'result':
      return e.result.status;
    default:
      return '';
  }
}

/** An event with its line number in events.jsonl, which is its identity. */
interface Entry {
  seq: number;
  event: RunEvent;
}

interface StepGroup {
  stepId: string;
  entries: Entry[];
}

function groupByStep(events: RunEvent[]): StepGroup[] {
  const groups: StepGroup[] = [];
  events.forEach((event, seq) => {
    const stepId = event.stepId ?? '(run)';
    const last = groups[groups.length - 1];
    if (last && last.stepId === stepId) last.entries.push({ seq, event });
    else groups.push({ stepId, entries: [{ seq, event }] });
  });
  return groups;
}

function ResultPanel({ result }: { result: ReplayResult | DiscoveryResult }) {
  switch (result.status) {
    case 'success':
      return (
        <>
          <p className="mb-2 text-sm">Outputs (masked for sensitive values):</p>
          <Json value={result.outputs} />
        </>
      );
    case 'outcome':
      return (
        <p className="text-sm">
          Business outcome <Mono>{result.code}</Mono>: {result.message}
          {result.atStep ? (
            <>
              {' '}
              at <Mono>{result.atStep}</Mono>
            </>
          ) : null}
        </p>
      );
    case 'failure':
      return (
        <div className="text-sm">
          <p>
            <Mono>{result.kind}</Mono>
            {result.atStep ? (
              <>
                {' '}
                at <Mono>{result.atStep}</Mono>
              </>
            ) : null}
          </p>
          <p>
            <span className="text-neutral-500">expected</span> {result.expected}
          </p>
          <p>
            <span className="text-neutral-500">observed</span> {result.observed}
          </p>
        </div>
      );
    case 'compiled':
      return (
        <p className="text-sm">
          Compiled{' '}
          <Link
            to={`/capabilities/${result.capability.id}/v/${result.capability.version}`}
            className="mono text-sky-800 hover:underline"
          >
            {result.capability.id} v{result.capability.version}
          </Link>{' '}
          from {result.stepsRecorded} recorded step(s).
        </p>
      );
    default:
      return (
        <p className="text-sm">
          {result.status}: {result.reason} ({result.stepsRecorded} step(s) recorded)
        </p>
      );
  }
}

function EventRow({ runId, entry }: { runId: string; entry: Entry }) {
  const e = entry.event;
  return (
    <li className="flex flex-wrap gap-3 px-3 py-1.5 text-sm">
      <span className="mono w-24 shrink-0 text-[12px] text-neutral-500">
        {new Date(e.at).toLocaleTimeString()}
      </span>
      <span className="w-28 shrink-0">
        <StatusBadge status={e.type} />
      </span>
      <span className="min-w-0 flex-1 break-words">
        <span className="text-neutral-500">{e.actor} · </span>
        {describeEvent(e)}
      </span>
      {e.type === 'observation' && e.screenshot ? (
        <a
          href={runFileUrl(runId, e.screenshot)}
          target="_blank"
          rel="noreferrer"
          className="shrink-0"
        >
          <img
            src={runFileUrl(runId, e.screenshot)}
            alt={`Screenshot ${e.screenshot} at ${formatTime(e.at)}`}
            loading="lazy"
            className="h-20 w-32 rounded border border-neutral-200 object-cover object-top"
          />
        </a>
      ) : null}
    </li>
  );
}

export function RunPage() {
  const { id = '' } = useParams<{ id: string }>();
  const q = useRun(id);
  if (q.isPending) return <Loading what="run" />;
  if (q.isError) return <ErrorBox error={q.error} />;
  const { run, events, result } = q.data;
  const groups = groupByStep(events);
  const replay = result && 'stepsRun' in result ? result : null;
  const detail =
    result && 'code' in result ? result.code : result && 'kind' in result ? result.kind : undefined;

  return (
    <>
      <PageTitle
        aside={
          <span className="flex items-center gap-2">
            <StatusBadge
              status={result?.status ?? (run.finishedAt ? 'unknown' : 'running')}
              detail={detail}
            />
            <span>
              {run.kind} · {formatTime(run.startedAt)} ·{' '}
              {formatDuration(run.startedAt, run.finishedAt)}
              {run.model ? ` · ${run.model}` : ''}
            </span>
          </span>
        }
      >
        <span className="mono">{run.id}</span>
      </PageTitle>
      <p className="mb-6 text-sm text-neutral-700">
        {run.capability ? (
          <>
            Capability{' '}
            <Link
              to={`/capabilities/${run.capability.id}/v/${run.capability.version}`}
              className="mono text-sky-800 hover:underline"
            >
              {run.capability.id} v{run.capability.version}
            </Link>
          </>
        ) : (
          <>Goal: {run.goal?.text}</>
        )}
        {' · '}target <Mono>{run.target.vendorProductId}</Mono>
        {run.target.variantId ? (
          <>
            {' / '}
            <Mono>{run.target.variantId}</Mono>
          </>
        ) : null}
        {' · '}control owner <Mono>{run.controlOwner}</Mono> · side effects{' '}
        <Mono>{run.sideEffects}</Mono>
      </p>

      <Section title="Result">
        {result ? <ResultPanel result={result} /> : <Empty>Still running.</Empty>}
        {replay && replay.stepsRun.length > 0 ? (
          <div className="mt-3">
            <Table head={['Step', 'Attempts', 'Duration', 'Resolved by', 'Candidates', 'Drift']}>
              {replay.stepsRun.map((s) => (
                <tr key={s.stepId}>
                  <Cell mono>{s.stepId}</Cell>
                  <Cell>{s.attempts}</Cell>
                  <Cell>{s.durationMs} ms</Cell>
                  <Cell>{s.resolvedBy !== undefined ? `strategy ${s.resolvedBy + 1}` : ''}</Cell>
                  <Cell>{s.candidateCount ?? ''}</Cell>
                  <Cell>{s.drift ? 'yes' : ''}</Cell>
                </tr>
              ))}
            </Table>
          </div>
        ) : null}
        {replay && replay.recoveries.length > 0 ? (
          <p className="mt-2 text-sm">
            {replay.recoveries.length} recovery(ies); see the timeline.
          </p>
        ) : null}
        {replay?.escalation ? (
          <p className="mt-2 text-sm">
            Escalation <Mono>{replay.escalation.id}</Mono> · {replay.escalation.resolution} ·{' '}
            {replay.escalation.humanActions.length} human action(s)
          </p>
        ) : null}
      </Section>

      <Section title="Timeline">
        {groups.length === 0 ? <Empty>No events recorded.</Empty> : null}
        <ol className="space-y-3">
          {groups.map((g) => (
            <li
              key={`${g.stepId}-${g.entries[0]?.seq ?? 0}`}
              className="rounded border border-neutral-200 bg-white"
            >
              <div className="border-b border-neutral-100 bg-neutral-50 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-neutral-600">
                {g.stepId}
              </div>
              <ul className="divide-y divide-neutral-100">
                {g.entries.map((entry) => (
                  <EventRow key={entry.seq} runId={run.id} entry={entry} />
                ))}
              </ul>
            </li>
          ))}
        </ol>
      </Section>

      <Section title="Raw">
        <details>
          <summary className="cursor-pointer text-sm text-neutral-600">
            run.json and result.json
          </summary>
          <Json value={{ run, result }} />
        </details>
      </Section>
    </>
  );
}
