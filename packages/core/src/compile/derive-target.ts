import {
  candidatesFor,
  cellAt,
  cellPosition,
  INTERACTIVE_ROLES,
  inFrame,
  resolveTarget,
} from '../resolve/resolve-target.js';
import type { A11yNode, Baseline, Strategy, TargetSpec } from '../schema/index.js';

/** Text that looks like data rather than a label: numbers, money, dates, ids, bare punctuation. */
export function looksLikeData(text: string): boolean {
  const t = text.trim();
  if (t === '') return true;
  if (!/[\p{L}\p{N}]/u.test(t)) return true;
  if (/^[\s$€£(),.\-+%\d]+$/.test(t)) return true;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return true;
  return /^[A-Z0-9-]{6,}$/.test(t) && /\d/.test(t);
}

function containsAny(text: string, values: string[]): boolean {
  return values.some((v) => v.length >= 3 && text.includes(v));
}

function firstNamedCellInRow(
  nodes: A11yNode[],
  rowPath: string,
  except: A11yNode,
  avoid: string[],
): A11yNode | undefined {
  for (let c = 1; c <= 12; c++) {
    const cell = cellAt(nodes, rowPath, c);
    if (!cell) break;
    if (cell.ref === except.ref || except.path.startsWith(`${cell.path}/`)) continue;
    if (cell.name.trim() && !looksLikeData(cell.name) && !containsAny(cell.name, avoid)) {
      return cell;
    }
  }
  return undefined;
}

/**
 * True when a cell of the row is exactly a parameter value. Such a row belongs to the entity the
 * parameter selected (a search hit, an account line), so its other cells are that entity's data,
 * never labels: a name or status recorded there would leak into the artifact and break on the
 * next invocation (D-032). Whole-cell equality only, as for URL bindings (D-013).
 */
function rowKeyedByParam(nodes: A11yNode[], rowPath: string, paramValues: string[]): boolean {
  for (let c = 1; c <= 12; c++) {
    const cell = cellAt(nodes, rowPath, c);
    if (!cell) break;
    const text = cell.name.trim();
    if (text !== '' && paramValues.some((v) => v.length >= 3 && v === text)) return true;
  }
  return false;
}

function nearestTextLeft(nodes: A11yNode[], node: A11yNode, avoid: string[]): A11yNode | undefined {
  const b = node.bbox;
  const candidates = nodes.filter(
    (n) =>
      n.ref !== node.ref &&
      (n.role === 'cell' || n.role === 'text' || n.role === 'heading' || n.role === 'label') &&
      n.name.trim() !== '' &&
      !looksLikeData(n.name) &&
      !containsAny(n.name, avoid) &&
      n.bbox.x + n.bbox.w <= b.x + 2 &&
      n.bbox.y < b.y + b.h &&
      b.y < n.bbox.y + n.bbox.h,
  );
  candidates.sort((p, q) => b.x - (p.bbox.x + p.bbox.w) - (b.x - (q.bbox.x + q.bbox.w)));
  return candidates[0];
}

/**
 * Proposes locator strategies for a node from what surrounds it, keeps only those that resolve
 * uniquely to that node, and returns at most three in the ranking of §8: role, anchored,
 * structural. Anchors and names that contain a parameter value are never used, so an artifact
 * cannot leak the values it was recorded with (D-013), and a table row keyed by a parameter value
 * contributes no anchors at all (D-032).
 */
export function deriveTargetSpec(
  node: A11yNode,
  nodes: A11yNode[],
  paramValues: string[] = [],
): TargetSpec {
  const frameNodes = nodes.filter((n) => inFrame(n, node.framePath));
  const proposals: Strategy[] = [];
  const interactive = INTERACTIVE_ROLES.has(node.role);

  if (node.name.trim() && !looksLikeData(node.name) && !containsAny(node.name, paramValues)) {
    proposals.push({ kind: 'role', role: node.role, name: node.name });
  }

  const pos = cellPosition(node.path);
  const keyedRow = pos ? rowKeyedByParam(frameNodes, pos.rowPath, paramValues) : false;
  if (pos && !keyedRow) {
    if (interactive) {
      for (let c = pos.col - 1; c >= 1; c--) {
        const cell = cellAt(frameNodes, pos.rowPath, c);
        if (
          cell?.name.trim() &&
          !looksLikeData(cell.name) &&
          !containsAny(cell.name, paramValues)
        ) {
          proposals.push({
            kind: 'anchored',
            anchor: cell.name,
            relation: 'labels',
            role: node.role,
          });
          break;
        }
      }
    }
    const rowAnchor = firstNamedCellInRow(frameNodes, pos.rowPath, node, paramValues);
    const headerRow = `${pos.tablePath}/tr[1]`;
    const header = headerRow === pos.rowPath ? undefined : cellAt(frameNodes, headerRow, pos.col);
    if (
      rowAnchor &&
      header?.name.trim() &&
      !looksLikeData(header.name) &&
      header.ref !== node.ref
    ) {
      proposals.push({
        kind: 'anchored',
        anchor: rowAnchor.name,
        relation: 'same-row-column',
        column: header.name,
        ...(node.role !== 'cell' ? { role: node.role } : {}),
      });
    }
  }

  if (!keyedRow && !proposals.some((p) => p.kind === 'anchored')) {
    // Interactive controls: the nearest text to the left. Plain cells: the label cell beside them,
    // which is how a key/value table ("Confirmation number | C-480221") names its values.
    const left = interactive
      ? nearestTextLeft(frameNodes, node, paramValues)
      : pos && pos.col > 1
        ? cellAt(frameNodes, pos.rowPath, pos.col - 1)
        : undefined;
    if (left?.name.trim() && !looksLikeData(left.name) && !containsAny(left.name, paramValues)) {
      proposals.push({
        kind: 'anchored',
        anchor: left.name,
        relation: 'right-of',
        role: node.role,
      });
    }
  }

  const structural: Strategy = { kind: 'structural', path: node.path.split('/').join(' > ') };
  proposals.push(structural);

  const kept = proposals
    .filter((s) => {
      const c = candidatesFor(frameNodes, s);
      return c.length === 1 && c[0]?.ref === node.ref;
    })
    .slice(0, 3);
  if (kept.length === 0) kept.push(structural);
  return { strategies: kept, framePath: node.framePath };
}

/** How the derived spec resolves on the observation it was derived from: the drift baseline (D-016). */
export function baselineOf(spec: TargetSpec, nodes: A11yNode[]): Baseline {
  const r = resolveTarget(nodes, spec);
  return r.found
    ? { resolvedBy: r.resolvedBy, candidateCount: r.candidateCount }
    : { resolvedBy: spec.strategies.length, candidateCount: 0 };
}
