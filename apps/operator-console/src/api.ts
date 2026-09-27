import type {
  CapabilityDetail,
  CapabilityListItem,
  ConsoleMessage,
  EscalationDetail,
  EscalationListItem,
  HandBackKind,
  RunDetail,
  RunListItem,
} from '@handsoff/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

/** All data comes over the runner's API (01 §3); the console imports types from core only. */
async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const parsed = (await res.json()) as { error?: string };
      if (parsed.error) message = parsed.error;
    } catch {
      // keep the status line
    }
    throw new Error(message);
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

export function useEscalations() {
  return useQuery({
    queryKey: ['escalations'],
    queryFn: () => getJson<EscalationListItem[]>('/api/escalations'),
    refetchInterval: 3_000,
  });
}

export function useEscalation(id: string) {
  return useQuery({
    queryKey: ['escalations', id],
    queryFn: () => getJson<EscalationDetail>(`/api/escalations/${encodeURIComponent(id)}`),
    refetchInterval: (query) => (query.state.data?.open ? 2_000 : false),
  });
}

export function claimEscalation(id: string, operatorId: string) {
  return postJson<{ escalation: EscalationDetail['escalation'] }>(
    `/api/escalations/${encodeURIComponent(id)}/claim`,
    { operatorId },
  );
}

export function handBackEscalation(id: string, operatorId: string, kind: HandBackKind) {
  return postJson<{ escalation: EscalationDetail['escalation'] }>(
    `/api/escalations/${encodeURIComponent(id)}/hand-back`,
    { operatorId, kind },
  );
}

/**
 * The runner's push channel (03 §4): each message invalidates the queries it touches. Polling
 * stays on as the fallback, so a dropped socket only makes the console slower, never stale.
 */
export function useLiveUpdates() {
  const queryClient = useQueryClient();
  useEffect(() => {
    let socket: WebSocket | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    const connect = () => {
      const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${protocol}://${location.host}/ws`);
      socket.onmessage = (event) => {
        let message: ConsoleMessage;
        try {
          message = JSON.parse(String(event.data)) as ConsoleMessage;
        } catch {
          return;
        }
        void queryClient.invalidateQueries({ queryKey: ['escalations'] });
        if (message.type === 'human_action') {
          void queryClient.invalidateQueries({ queryKey: ['escalations', message.escalationId] });
          void queryClient.invalidateQueries({ queryKey: ['runs', message.runId] });
        } else if (message.type === 'escalation') {
          void queryClient.invalidateQueries({ queryKey: ['runs', message.escalation.runId] });
          void queryClient.invalidateQueries({ queryKey: ['runs'] });
        } else {
          void queryClient.invalidateQueries({ queryKey: ['runs', message.runId] });
          void queryClient.invalidateQueries({ queryKey: ['runs'] });
        }
      };
      socket.onclose = () => {
        if (!closed) timer = setTimeout(connect, 3_000);
      };
      socket.onerror = () => socket?.close();
    };
    connect();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      socket?.close();
    };
  }, [queryClient]);
}

/** A screenshot or snapshot inside a run folder, e.g. `steps/003-s1-before.png`. */
export function runFileUrl(runId: string, relativePath: string): string {
  const parts = relativePath.split(/[\\/]/).map(encodeURIComponent);
  return `/api/run-files/${encodeURIComponent(runId)}/${parts.join('/')}`;
}
