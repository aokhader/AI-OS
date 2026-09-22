import { randomBytes } from 'node:crypto';

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

/** run_YYYYMMDD_HHMMSS_xxxx, sortable by start time. */
export function newRunId(now: Date = new Date()): string {
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `run_${date}_${time}_${randomBytes(2).toString('hex')}`;
}

export function newEscalationId(now: Date = new Date()): string {
  return `esc_${now.getTime().toString(36)}_${randomBytes(2).toString('hex')}`;
}
