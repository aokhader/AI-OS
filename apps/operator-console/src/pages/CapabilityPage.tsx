import type { Capability, Condition, Predicate, TargetSpec } from '@handsoff/core';
import { Link, useParams } from 'react-router';
import { useCapability } from '../api';
import {
  Cell,
  ErrorBox,
  formatTime,
  Json,
  Loading,
  Mono,
  PageTitle,
  Section,
  StatusBadge,
  Table,
} from '../components/ui';

/** Compact text for a target: one line per strategy, in resolution order (01 §8). */
export function describeTarget(target: TargetSpec | undefined): string {
  if (!target) return '';
  return target.strategies
    .map((s) => {
      switch (s.kind) {
        case 'role':
          return `role ${s.role} "${s.name}"`;
        case 'anchored':
          return `${s.relation} "${s.anchor}"${s.column ? ` · ${s.column}` : ''}${s.role ? ` (${s.role})` : ''}`;
        case 'structural':
          return `path ${s.path}`;
        default:
          return JSON.stringify(s);
      }
    })
    .join('\n');
}

export function describePredicate(when: Predicate): string {
  const parts: string[] = [];
  if (when.url) parts.push(`url ${when.url}`);
  if (when.textPresent?.length)
    parts.push(`text ${when.textPresent.map((t) => `"${t}"`).join(', ')}`);
  if (when.textAbsent?.length)
    parts.push(`no text ${when.textAbsent.map((t) => `"${t}"`).join(', ')}`);
  if (when.element) parts.push('element resolves');
  if (when.dialog !== undefined) parts.push(when.dialog ? 'dialog open' : 'no dialog');
  if (when.frameTitle) parts.push(`frame "${when.frameTitle}"`);
  return parts.join(' · ') || '(always)';
}

function describeAction(action: Capability['steps'][number]['action']): string {
  const a = action as Record<string, unknown> & { kind: string };
  const value = a.value as { text?: string; param?: string } | undefined;
  const v = value?.param ? `{${value.param}}` : value?.text !== undefined ? `"${value.text}"` : '';
  switch (a.kind) {
    case 'type':
    case 'select':
      return `${a.kind} ${v}`;
    case 'press':
      return `press ${String(a.key ?? '')}`;
    case 'navigate': {
      const url = a.url as { text?: string; param?: string } | undefined;
      return `navigate ${url?.param ? `{${url.param}}` : (url?.text ?? '')}`;
    }
    case 'extract':
      return `extract ${String(a.output ?? a.name ?? '')}`;
    default:
      return a.kind;
  }
}

function ConditionRow({ c }: { c: Condition }) {
  return (
    <tr>
      <Cell mono>{c.id}</Cell>
      <Cell>{c.class ? <StatusBadge status={c.class} detail={c.code} /> : c.role}</Cell>
      <Cell mono>{describePredicate(c.when)}</Cell>
    </tr>
  );
}

export function CapabilityPage() {
  const params = useParams<{ id: string; version?: string }>();
  const id = params.id ?? '';
  const version = params.version ? Number.parseInt(params.version, 10) : undefined;
  const q = useCapability(id, version);

  if (q.isPending) return <Loading what="capability" />;
  if (q.isError) return <ErrorBox error={q.error} />;
  const { capability: c, versions } = q.data;

  return (
    <>
      <PageTitle
        aside={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status={c.status} />
            <span>
              versions:{' '}
              {versions.map((v) => (
                <Link
                  key={v}
                  to={`/capabilities/${c.id}/v/${v}`}
                  className={`mono mr-1 ${v === c.version ? 'font-semibold' : 'text-sky-800 hover:underline'}`}
                >
                  v{v}
                </Link>
              ))}
            </span>
          </span>
        }
      >
        {c.name}
      </PageTitle>
      <p className="mb-4 text-sm text-neutral-600">
        <Mono>{c.id}</Mono> v{c.version}
        {c.supersedes ? ` (supersedes v${c.supersedes})` : ''} · recorded{' '}
        {formatTime(c.provenance.recordedAt)} by{' '}
        <Mono>
          {c.provenance.provider ? `${c.provenance.provider} · ` : ''}
          {c.provenance.model}
        </Mono>{' '}
        from run{' '}
        <Link to={`/runs/${c.provenance.runId}`} className="mono text-sky-800 hover:underline">
          {c.provenance.runId}
        </Link>
        {' · '}entry <Mono>{c.entry.route}</Mono>
        {c.entry.requiresAuth ? ' (signed in)' : ''}
      </p>
      <p className="mb-6 text-sm text-neutral-700">{c.description}</p>

      <Section title="Inputs">
        <Table head={['Name', 'Type', 'Sensitivity', 'Required', 'Description']}>
          {c.inputs.map((i) => (
            <tr key={i.name}>
              <Cell mono>{i.name}</Cell>
              <Cell mono>{i.type}</Cell>
              <Cell>{i.sensitivity}</Cell>
              <Cell>{i.required ? 'yes' : 'no'}</Cell>
              <Cell>{i.description}</Cell>
            </tr>
          ))}
        </Table>
      </Section>

      <Section title="Outputs">
        <Table head={['Name', 'Type', 'Parser', 'Sensitivity', 'At step', 'Source']}>
          {c.outputs.map((o) => (
            <tr key={o.name}>
              <Cell mono>{o.name}</Cell>
              <Cell mono>{o.type}</Cell>
              <Cell mono>{o.parser ?? ''}</Cell>
              <Cell>{o.sensitivity}</Cell>
              <Cell mono>{o.atStep}</Cell>
              <Cell>
                <pre className="mono whitespace-pre-wrap text-[12px]">
                  {'strategies' in o.source ? describeTarget(o.source) : JSON.stringify(o.source)}
                </pre>
              </Cell>
            </tr>
          ))}
        </Table>
      </Section>

      <Section title="Steps">
        <Table head={['Id', 'Action', 'Intent', 'Target', 'Postcondition', 'Risk']}>
          {c.steps.map((s) => (
            <tr key={s.id}>
              <Cell mono>{s.id}</Cell>
              <Cell mono>{describeAction(s.action)}</Cell>
              <Cell>{s.intent}</Cell>
              <Cell>
                <pre className="mono whitespace-pre-wrap text-[12px]">
                  {describeTarget(s.target)}
                </pre>
              </Cell>
              <Cell mono>{s.postcondition ? describePredicate(s.postcondition.when) : ''}</Cell>
              <Cell>
                {s.risk}
                {s.confirm && s.confirm !== 'none' ? ` · confirm: ${s.confirm}` : ''}
              </Cell>
            </tr>
          ))}
        </Table>
      </Section>

      <Section title="Success and detectors">
        <Table head={['Id', 'Class', 'When']}>
          <ConditionRow c={c.success} />
          {c.entry.preconditions.map((p) => (
            <ConditionRow key={p.id} c={p} />
          ))}
          {c.detectors.map((d) => (
            <ConditionRow key={d.id} c={d} />
          ))}
        </Table>
      </Section>

      <Section title="Artifact">
        <details>
          <summary className="cursor-pointer text-sm text-neutral-600">
            Raw JSON (v{c.version})
          </summary>
          <Json value={c} />
        </details>
      </Section>
    </>
  );
}
