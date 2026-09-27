import type { EscalationListItem } from '@handsoff/core';
import { Link } from 'react-router';
import { useEscalations } from '../api';
import {
  Cell,
  Empty,
  ErrorBox,
  formatDuration,
  formatTime,
  Loading,
  Mono,
  PageTitle,
  StatusBadge,
  Table,
} from '../components/ui';

export function escalationStatus(item: EscalationListItem): {
  status: string;
  detail?: string | undefined;
} {
  const e = item.escalation;
  if (e.resolution) return { status: e.resolution.kind, detail: e.resolution.by };
  if (e.claimedBy) return { status: 'human', detail: e.claimedBy };
  return { status: 'awaiting_operator', detail: item.live ? undefined : 'not live here' };
}

function subject(item: EscalationListItem): string {
  const e = item.escalation;
  return e.capability ? `${e.capability.id} v${e.capability.version}` : (e.goal ?? '');
}

/** The inbox (03 §2): open escalations first, newest first within each group. */
export function EscalationsPage() {
  const q = useEscalations();
  const open = q.data?.filter((i) => i.open).length ?? 0;
  return (
    <>
      <PageTitle aside={q.data ? `${open} open · ${q.data.length} total` : undefined}>
        Escalations
      </PageTitle>
      {q.isPending ? <Loading what="escalations" /> : null}
      {q.isError ? <ErrorBox error={q.error} /> : null}
      {q.data && q.data.length === 0 ? (
        <Empty>
          No escalations yet. A run escalates when a step needs confirmation, a condition asks for
          an operator, the model asks for help, or a failure is left for a person to fix. Start one
          with{' '}
          <Mono>
            pnpm handsoff replay --capability open-sub-account --param memberId=10001 --param
            accountType=Checking --param deposit=40.00 --operator console
          </Mono>
          .
        </Empty>
      ) : null}
      {q.data && q.data.length > 0 ? (
        <Table head={['Escalation', 'Cause', 'Run', 'Capability / goal', 'Step', 'Status', 'Age']}>
          {q.data.map((item) => {
            const e = item.escalation;
            const { status, detail } = escalationStatus(item);
            return (
              <tr key={e.id} className="hover:bg-neutral-50">
                <Cell mono>
                  <Link to={`/escalations/${e.id}`} className="text-sky-800 hover:underline">
                    {e.id}
                  </Link>
                </Cell>
                <Cell mono>{e.cause}</Cell>
                <Cell mono>
                  <Link to={`/runs/${e.runId}`} className="text-sky-800 hover:underline">
                    {e.runId}
                  </Link>
                </Cell>
                <Cell>{subject(item)}</Cell>
                <Cell mono>{e.atStep ?? ''}</Cell>
                <Cell>
                  <StatusBadge status={status} detail={detail} />
                </Cell>
                <Cell>
                  <span title={formatTime(e.requestedAt)}>
                    {formatDuration(e.requestedAt, e.resolution?.at)}
                  </span>
                </Cell>
              </tr>
            );
          })}
        </Table>
      ) : null}
    </>
  );
}
