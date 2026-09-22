import type { OutputSpec } from '../schema/index.js';

export function parseCurrency(raw: string): number | undefined {
  const trimmed = raw.replace(/\s+/g, ' ').trim();
  const negative = /^\(.*\)$/.test(trimmed) || trimmed.startsWith('-');
  const digits = trimmed.replace(/[^0-9.]/g, '');
  if (digits === '' || digits === '.') return undefined;
  const n = Number(digits);
  if (!Number.isFinite(n)) return undefined;
  return negative ? -n : n;
}

export function parseDate(raw: string): string | undefined {
  const d = new Date(raw.trim());
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
}

/** Applies the output spec's parser and type. Returns undefined when the raw text cannot be parsed. */
export function parseOutput(raw: string, spec: OutputSpec): unknown {
  const text = raw.replace(/\s+/g, ' ').trim();
  switch (spec.parser ?? (spec.type === 'date' ? 'date' : 'text')) {
    case 'currency':
      return parseCurrency(text);
    case 'date':
      return parseDate(text);
    default:
      break;
  }
  switch (spec.type) {
    case 'number': {
      const n = Number(text.replace(/,/g, ''));
      return Number.isFinite(n) ? n : undefined;
    }
    case 'boolean':
      return /^(true|yes|y|1|on|checked)$/i.test(text);
    default:
      return text;
  }
}
