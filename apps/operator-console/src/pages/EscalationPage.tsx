import type { HandBackKind, RecordedStep } from '@handsoff/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { claimEscalation, handBackEscalation, runFileUrl, useEscalation } from '../api';
import {
  Empty,
  ErrorBox,
  formatTime,
  Loading,
  Mono,
  PageTitle,
  Section,
  StatusBadge,
} from '../components/ui';
import { escalationStatus } from './EscalationsPage';

const HAND_BACK_LABELS: Record<HandBackKind, { label: string; hint: string }> = {
  approve_step: {
    label: 'Approve step',
    hint: 'Automation runs the step that asked for confirmation.',
  },
  resume: {
    label: 'Resume automation',
    hint: 'Automation works out where you left the page from the step checkpoints and continues.',
  },
  mark_complete: {
    label: 'Mark complete',
    hint: 'Automation verifies the success condition and reads the outputs from the page.',
  },
  abort: { label: 'Abort', hint: 'The run ends as a failure; nothing else executes.' },
};

function describeTarget(step: RecordedStep): string {
  const s = step.target?.strategies[0];
  if (!s) return '';
  switch (s.kind) {
    case 'role':
      return `${s.role} "${s.name}"`;
    case 'anchored':
      return `${s.role ?? 'element'} ${s.relation} "${s.anchor}"${s.column ? ` · ${s.column}` : ''}`;
    case 'structural':
      return s.path;
  }
}

/**
 * Escalation detail (03 §2, §3): why the run stopped, the latest masked screenshot, claim and
 * hand-back controls, and the live feed of what the person did in the browser window.
 */
export function EscalationPage() {
  const { id = '' } = useParams<{ id: string }>();
  const q = useEscalation(id);
  const queryClient = useQueryClient();
  const [operatorId, setOperatorId] = useState('operator');
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['escalations'] });
    void queryClient.invalidateQueries({ queryKey: ['runs'] });
  };
  const claim = useMutation({
    mutationFn: () => claimEscalation(id, operatorId),
    onSuccess: refresh,
  });
  const handBack = useMutation({
    mutationFn: (kind: HandBackKind) => handBackEscalation(id, operatorId, kind),
    onSuccess: refresh,
  });

  if (q.isPending) return <Loading what="escalation" />;
  if (q.isError) return <ErrorBox error={q.error} />;
  const { escalation: e, humanActions, open, live } = q.data;
  const { status, detail } = escalationStatus(q.data);
  const claimed = Boolean(e.claimedBy);
  const busy = claim.isPending || handBack.isPending;
  const error = claim.error ?? handBack.error;

  return (
    <>
      <PageTitle
        aside={
          <span className="flex items-center gap-2">
            <StatusBadge status={status} detail={detail} />
            <span>
              {e.phase} ·{' '}
              <Link to={`/runs/${e.runId}`} className="mono text-sky-800 hover:underline">
                {e.runId}
              </Link>
            </span>
          </span>
        }
      >
        <span className="mono">{e.id}</span>
      </PageTitle>

      <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div>
          <Section title="Why automation stopped">
            <dl className="grid grid-cols-[8rem_1fr] gap-y-1 text-sm">
              <dt className="text-neutral-500">Cause</dt>
              <dd>
                <Mono>{e.cause}</Mono>
              </dd>
              <dt className="text-neutral-500">Detail</dt>
              <dd>{e.detail}</dd>
              <dt className="text-neutral-500">Step</dt>
              <dd>
                <Mono>{e.atStep ?? 'run'}</Mono>
                {e.stepIntent ? ` · ${e.stepIntent}` : ''}
              </dd>
              <dt className="text-neutral-500">Doing</dt>
              <dd>
                {e.capability ? (
                  <Link
                    to={`/capabilities/${e.capability.id}/v/${e.capability.version}`}
                    className="mono text-sky-800 hover:underline"
                  >
                    {e.capability.id} v{e.capability.version}
                  </Link>
                ) : (
                  e.goal
                )}
              </dd>
              <dt className="text-neutral-500">Requested</dt>
              <dd>{formatTime(e.requestedAt)}</dd>
              {e.claimedBy ? (
                <>
                  <dt className="text-neutral-500">Claimed</dt>
                  <dd>
                    {e.claimedBy} · {formatTime(e.claimedAt)}
                  </dd>
                </>
              ) : null}
              {e.resolution ? (
                <>
                  <dt className="text-neutral-500">Resolved</dt>
                  <dd>
                    <Mono>{e.resolution.kind}</Mono>
                    {e.resolution.by ? ` by ${e.resolution.by}` : ''} ·{' '}
                    {formatTime(e.resolution.at)}
                    {e.resolution.humanActions
                      ? ` · ${e.resolution.humanActions} human action(s)`
                      : ''}
                  </dd>
                </>
              ) : null}
            </dl>
          </Section>

          <Section title="Controls">
            {!open ? (
              <p className="text-sm text-neutral-600">
                This escalation is resolved. See the{' '}
                <Link to={`/runs/${e.runId}`} className="text-sky-800 hover:underline">
                  run
                </Link>{' '}
                for what happened next.
              </p>
            ) : !live ? (
              <Empty>
                This escalation belongs to a run in another process. Claim it from the process that
                owns the browser: start the run with <Mono>--operator console</Mono> and open this
                console against that port.
              </Empty>
            ) : (
              <div className="space-y-3 text-sm">
                <label className="flex items-center gap-2">
                  <span className="w-24 text-neutral-500">Operator</span>
                  <input
                    className="rounded border border-neutral-300 px-2 py-1"
                    value={operatorId}
                    onChange={(ev) => setOperatorId(ev.target.value)}
                    disabled={claimed}
                    aria-label="Operator id"
                  />
                </label>
                {!claimed ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      className="rounded bg-neutral-900 px-3 py-1.5 text-white disabled:opacity-50"
                      disabled={busy || operatorId.trim() === ''}
                      onClick={() => claim.mutate()}
                    >
                      Claim and work in the browser
                    </button>
                    <span className="text-neutral-500">
                      Control moves to you; every click, change and Enter in the browser window is
                      recorded.
                    </span>
                  </div>
                ) : (
                  <p className="rounded border border-sky-200 bg-sky-50 p-2 text-sky-900">
                    You have control ({e.claimedBy}). Work in the headed browser window, then hand
                    back below.
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  {e.suggestedActions.map((kind) => (
                    <button
                      key={kind}
                      type="button"
                      title={HAND_BACK_LABELS[kind].hint}
                      className={`rounded px-3 py-1.5 ring-1 ring-inset disabled:opacity-50 ${
                        kind === 'abort'
                          ? 'bg-rose-50 text-rose-900 ring-rose-300'
                          : 'bg-white text-neutral-900 ring-neutral-300 hover:bg-neutral-100'
                      }`}
                      disabled={busy || operatorId.trim() === ''}
                      onClick={() => handBack.mutate(kind)}
                    >
                      {HAND_BACK_LABELS[kind].label}
                    </button>
                  ))}
                </div>
                <ul className="list-disc pl-5 text-neutral-600">
                  {e.suggestedActions.map((kind) => (
                    <li key={kind}>
                      <span className="font-medium text-neutral-800">
                        {HAND_BACK_LABELS[kind].label}:
                      </span>{' '}
                      {HAND_BACK_LABELS[kind].hint}
                    </li>
                  ))}
                </ul>
                {error ? (
                  <p className="text-rose-800">{error instanceof Error ? error.message : ''}</p>
                ) : null}
              </div>
            )}
          </Section>

          <Section title={`Human actions (${humanActions.length})`}>
            {humanActions.length === 0 ? (
              <p className="text-sm text-neutral-500">
                Nothing recorded yet. Actions appear here as they happen in the browser.
              </p>
            ) : (
              <ol className="divide-y divide-neutral-100 rounded border border-neutral-200 bg-white text-sm">
                {humanActions.map((step) => (
                  <li key={step.id} className="flex flex-wrap gap-3 px-3 py-1.5">
                    <Mono>{step.id}</Mono>
                    <span>{step.intent}</span>
                    <span className="text-neutral-500">
                      {step.action.kind}
                      {describeTarget(step) ? ` · ${describeTarget(step)}` : ''}
                      {step.risk === 'risky' ? ' · risky' : ''}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </Section>
        </div>

        <div>
          <Section title="Latest screenshot (masked)">
            {e.screenshot && e.screenshot !== 'none' ? (
              <a href={runFileUrl(e.runId, e.screenshot)} target="_blank" rel="noreferrer">
                <img
                  src={runFileUrl(e.runId, e.screenshot)}
                  alt={`Page at ${e.atStep ?? 'the escalation'}, ${formatTime(e.requestedAt)}`}
                  className="w-full rounded border border-neutral-200"
                />
              </a>
            ) : (
              <p className="text-sm text-neutral-500">No screenshot was available.</p>
            )}
          </Section>
        </div>
      </div>
    </>
  );
}
