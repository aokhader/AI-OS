import type { CapabilityDetail, CapabilityListItem, RunDetail, RunListItem } from '@handsoff/core';
import { useQuery } from '@tanstack/react-query';

/** All data comes over the runner's read API (01 §3); the console imports types from core only. */
async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

export function useRuns() {
  return useQuery({
    queryKey: ['runs'],
    queryFn: () => getJson<RunListItem[]>('/api/runs'),
    refetchInterval: 5_000,
  });
}

export function useRun(id: string) {
  return useQuery({
    queryKey: ['runs', id],
    queryFn: () => getJson<RunDetail>(`/api/runs/${encodeURIComponent(id)}`),
    refetchInterval: (query) => (query.state.data?.run.finishedAt ? false : 3_000),
  });
}

export function useCapabilities() {
  return useQuery({
    queryKey: ['capabilities'],
    queryFn: () => getJson<CapabilityListItem[]>('/api/capabilities'),
  });
}

export function useCapability(id: string, version?: number) {
  const url =
    version === undefined
      ? `/api/capabilities/${encodeURIComponent(id)}`
      : `/api/capabilities/${encodeURIComponent(id)}/v/${version}`;
  return useQuery({
    queryKey: ['capabilities', id, version ?? 'latest'],
    queryFn: () => getJson<CapabilityDetail>(url),
  });
}

/** A screenshot or snapshot inside a run folder, e.g. `steps/003-s1-before.png`. */
export function runFileUrl(runId: string, relativePath: string): string {
  const parts = relativePath.split(/[\\/]/).map(encodeURIComponent);
  return `/api/run-files/${encodeURIComponent(runId)}/${parts.join('/')}`;
}
