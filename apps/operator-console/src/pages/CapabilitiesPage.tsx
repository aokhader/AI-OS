import { Link } from 'react-router';
import { useCapabilities } from '../api';
import {
  Cell,
  Empty,
  ErrorBox,
  formatTime,
  Loading,
  Mono,
  PageTitle,
  StatusBadge,
  Table,
} from '../components/ui';

export function CapabilitiesPage() {
  const caps = useCapabilities();
  return (
    <>
      <PageTitle aside={caps.data ? `${caps.data.length} capability(ies)` : undefined}>
        Capabilities
      </PageTitle>
      {caps.isPending ? <Loading what="capabilities" /> : null}
      {caps.isError ? <ErrorBox error={caps.error} /> : null}
      {caps.data && caps.data.length === 0 ? (
        <Empty>
          No capabilities under <Mono>data/capabilities</Mono>. Discover one with{' '}
          <Mono>pnpm handsoff discover</Mono>.
        </Empty>
      ) : null}
      {caps.data && caps.data.length > 0 ? (
        <Table head={['Id', 'Name', 'Latest', 'Status', 'Steps', 'Recorded by', 'Recorded']}>
          {caps.data.map((c) => (
            <tr key={c.id} className="hover:bg-neutral-50">
              <Cell mono>
                <Link to={`/capabilities/${c.id}`} className="text-sky-800 hover:underline">
                  {c.id}
                </Link>
              </Cell>
              <Cell>{c.name}</Cell>
              <Cell mono>v{c.version}</Cell>
              <Cell>
                <StatusBadge status={c.status} />
              </Cell>
              <Cell>{c.stepCount}</Cell>
              <Cell mono>{c.provider ? `${c.provider} · ${c.model}` : c.model}</Cell>
              <Cell>{formatTime(c.recordedAt)}</Cell>
            </tr>
          ))}
        </Table>
      ) : null}
    </>
  );
}
