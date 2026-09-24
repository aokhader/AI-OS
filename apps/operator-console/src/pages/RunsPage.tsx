import type { RunListItem } from '@handsoff/core';
import { Link } from 'react-router';
import { useRuns } from '../api';
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

function statusOf(item: RunListItem): { status: string; detail?: string | undefined } {
  const s = item.summary;
  if (!s) return { status: item.run.finishedAt ? 'unknown' : 'running' };
  return { status: s.status, detail: s.code ?? s.kind ?? s.reason };
}

function subject(item: RunListItem): string {
  const { run } = item;
  if (run.capability) return `${run.capability.id} v${run.capability.version}`;
  return run.goal?.text ?? '';
}

export function RunsPage() {
  const runs = useRuns();
  return (
    <>
      <PageTitle aside={runs.data ? `${runs.data.length} run(s)` : undefined}>Runs</PageTitle>
      {runs.isPending ? <Loading what="runs" /> : null}
      {runs.isError ? <ErrorBox error={runs.error} /> : null}
      {runs.data && runs.data.length === 0 ? (
        <Empty>
          No runs yet. Try{' '}
          <Mono>
            pnpm handsoff replay --capability get-member-savings-balance --param memberId=10001
          </Mono>
          .
        </Empty>
      ) : null}
      {runs.data && runs.data.length > 0 ? (
        <Table
          head={['Run', 'Kind', 'Capability / goal', 'Status', 'Started', 'Duration', 'Model']}
        >
          {runs.data.map((item) => {
            const { status, detail } = statusOf(item);
            return (
              <tr key={item.run.id} className="hover:bg-neutral-50">
                <Cell mono>
                  <Link to={`/runs/${item.run.id}`} className="text-sky-800 hover:underline">
                    {item.run.id}
                  </Link>
                </Cell>
                <Cell>{item.run.kind}</Cell>
                <Cell>{subject(item)}</Cell>
                <Cell>
                  <StatusBadge status={status} detail={detail} />
                </Cell>
                <Cell>{formatTime(item.run.startedAt)}</Cell>
                <Cell>{formatDuration(item.run.startedAt, item.run.finishedAt)}</Cell>
                <Cell mono>{item.run.model ?? ''}</Cell>
              </tr>
            );
          })}
        </Table>
      ) : null}
    </>
  );
}
