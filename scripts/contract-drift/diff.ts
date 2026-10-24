/** The semantic diff between two contract dumps: which machine moves,
 * money flags, and joint-state invariants changed. Pure data in, report
 * lines out, so the tests pin every change kind. */

import { unique } from "#fp";
import {
  type Contracts,
  type DumpedDeclaredMoves,
  type DumpedJointState,
  type DumpedMachine,
  type DumpedMoveCell,
  jointStateKey,
  sortedStrings,
} from "./dump.ts";

/** One event's row in one state: who fires it, and every node it can land
 * on (a split cell lands on more than one). */
type EdgeRow = { actor: string; targets: Set<string> };

/** Which side of a pair a line reports: what the base had and this tree
 * lost, or the other way round. */
type DriftSide = "-" | "+";

/** The word each side's state and invariant lines carry. */
const REMOVED_OR_ADDED: Readonly<Record<DriftSide, string>> = {
  "-": "removed",
  "+": "added",
};

/** The words each side's state line carries. */
const STATE_WORD: Readonly<Record<DriftSide, string>> = {
  "-": "state removed",
  "+": "state added",
};

/** One machine's two sides: what the base held, and what this tree holds. */
type MachinePair = {
  readonly after: DumpedMachine;
  readonly before: DumpedMachine;
  readonly id: string;
};

/** The word each side's money line carries. */
const MONEY_WORD: Readonly<Record<DriftSide, string>> = {
  "-": "stops moving money",
  "+": "moves money",
};

const EMPTY_ROWS: ReadonlyMap<string, EdgeRow> = new Map();

/** One machine's rows: state → event → its row. */
const edgeRows = (
  machine: DumpedMachine,
): ReadonlyMap<string, ReadonlyMap<string, EdgeRow>> => {
  const rows = new Map<string, Map<string, EdgeRow>>();
  for (const [from, edges] of Object.entries(machine.edges)) {
    const byEvent = new Map<string, EdgeRow>();
    for (const edge of edges) {
      const row = byEvent.get(edge.event) ?? {
        actor: edge.actor,
        targets: new Set<string>(),
      };
      row.targets.add(edge.to);
      byEvent.set(edge.event, row);
    }
    rows.set(from, byEvent);
  }
  return rows;
};

/** The move lines for one event's targets. The sign and verb name what
 * happened; the rest names where. */
const moveLines =
  (sign: DriftSide, verb: string) =>
  (where: string, event: string, targets: ReadonlySet<string>): string[] =>
    [...targets].map(
      (to) => `${sign} move ${verb}: ${where} --${event}--> ${to}`,
    );

const refusedLines = moveLines("-", "refused");
const allowedLines = moveLines("+", "allowed");

/** The targets one side holds and the other does not. */
const onlyIn = (
  values: ReadonlySet<string>,
  other: ReadonlySet<string>,
): ReadonlySet<string> =>
  new Set([...values].filter((value) => !other.has(value)));

/** The lines for one event both sides hold: the actor first, then each
 * target that changed. */
const sharedEventDrift = (
  where: string,
  event: string,
  row: EdgeRow,
  next: EdgeRow,
): string[] => {
  const changedTargets = [
    ...refusedLines(where, event, onlyIn(row.targets, next.targets)),
    ...allowedLines(where, event, onlyIn(next.targets, row.targets)),
  ];
  if (row.actor === next.actor) return changedTargets;
  return [
    `~ actor changed: ${where} --${event}--> now ${next.actor} (was ${row.actor})`,
    ...changedTargets,
  ];
};

/** The lines for one state: what the base allowed and this tree changed,
 * then what only this tree allows. */
const stateDrift = (
  where: string,
  before: ReadonlyMap<string, EdgeRow>,
  after: ReadonlyMap<string, EdgeRow>,
): string[] => {
  const lines: string[] = [];
  for (const [event, row] of before) {
    const next = after.get(event);
    if (next === undefined) {
      lines.push(...refusedLines(where, event, row.targets));
      continue;
    }
    lines.push(...sharedEventDrift(where, event, row, next));
  }
  for (const [event, row] of after) {
    if (before.has(event)) continue;
    lines.push(...allowedLines(where, event, row.targets));
  }
  return lines;
};

/** The removals then the additions between two lists, compared by key.
 * One helper behind the states, money flags, and seam lines, so no two of
 * them can drift apart. */
const driftBetween = <Item>(
  before: readonly Item[],
  after: readonly Item[],
  keyOf: (item: Item) => string,
  lineFor: (side: DriftSide, item: Item) => string,
): string[] => {
  const beforeKeys = new Set(before.map(keyOf));
  const afterKeys = new Set(after.map(keyOf));
  return [
    ...before
      .filter((item) => !afterKeys.has(keyOf(item)))
      .map((item) => lineFor("-", item)),
    ...after
      .filter((item) => !beforeKeys.has(keyOf(item)))
      .map((item) => lineFor("+", item)),
  ];
};

/** One machine's drift for one field: both sides read the same field, and
 * the field's own differ compares them. */
const fieldDrift =
  <View>(
    viewOf: (machine: DumpedMachine) => View,
    drift: (before: View, after: View, id: string) => string[],
  ) =>
  ({ after, before, id }: MachinePair): string[] =>
    drift(viewOf(before), viewOf(after), id);

/** The lines for one machine's moves. */
const edgeDrift = fieldDrift(edgeRows, (rowsBefore, rowsAfter, id) => {
  const froms = sortedStrings([
    ...unique([...rowsBefore.keys(), ...rowsAfter.keys()]),
  ]);
  const lines: string[] = [];
  for (const from of froms) {
    lines.push(
      ...stateDrift(
        `${id}.${from}`,
        rowsBefore.get(from) ?? EMPTY_ROWS,
        rowsAfter.get(from) ?? EMPTY_ROWS,
      ),
    );
  }
  return lines;
});

/** The lines for the cells two present tables hold: each node in key
 * order, then within a node the base table's cells first (each refusal
 * and retarget), then the head table's new cells (each allowance). The
 * dump sorts both tables' keys. */
const cellDrift = (
  id: string,
  beforeTable: DumpedDeclaredMoves,
  afterTable: DumpedDeclaredMoves,
): string[] => {
  const lines: string[] = [];
  const nodes = sortedStrings(
    unique([...Object.keys(beforeTable), ...Object.keys(afterTable)]),
  );
  for (const node of nodes) {
    const beforeCells = beforeTable[node];
    const afterCells = afterTable[node];
    const where = `${id}.${node}`;
    for (const [event, beforeCell] of Object.entries(beforeCells ?? {})) {
      const line = declaredCellDrift(
        where,
        event,
        beforeCell,
        afterCells?.[event],
      );
      if (line !== undefined) lines.push(line);
    }
    for (const [event, afterCell] of Object.entries(afterCells ?? {})) {
      if (beforeCells?.[event] !== undefined) continue;
      lines.push(allowedCellLine(where, event, afterCell));
    }
  }
  return lines;
};

/** The lines for one machine's declared table: the table itself appearing
 * or leaving, then each cell that changed. */
const declaredDrift = fieldDrift(
  (machine) => machine.declaredMoves,
  (beforeTable, afterTable, id) => {
    if (beforeTable === undefined && afterTable === undefined) return [];
    if (beforeTable === undefined) {
      return [`+ declared moves table added: ${id}`];
    }
    if (afterTable === undefined) {
      return [`- declared moves table removed: ${id}`];
    }
    return cellDrift(id, beforeTable, afterTable);
  },
);

/** How one declared cell reads in a report: a plain cell names its landing
 * node; a split names the node each stored shape lands on. */
const cellWord = (cell: DumpedMoveCell): string => {
  if (typeof cell === "string") return cell;
  const shapes = Object.entries(cell.perRep)
    .map(([shape, to]) => `${shape}: ${to}`)
    .sort()
    .join(", ");
  return `perRep {${shapes}}`;
};

/** The line one cell the base table holds earns, or undefined when the
 * cell stayed: a cell the head table dropped is a refused move, and a
 * cell the head table moved names its retarget. */
const declaredCellDrift = (
  where: string,
  event: string,
  beforeCell: DumpedMoveCell,
  afterCell: DumpedMoveCell | undefined,
): string | undefined => {
  const route = `${where} --${event}-->`;
  if (afterCell === undefined) {
    return `- declared move refused: ${route} ${cellWord(beforeCell)}`;
  }
  const was = cellWord(beforeCell);
  const now = cellWord(afterCell);
  if (was === now) return;
  return `~ declared move retargeted: ${route} now ${now} (was ${was})`;
};

/** The line one cell only the head table holds earns. */
const allowedCellLine = (
  where: string,
  event: string,
  afterCell: DumpedMoveCell,
): string =>
  `+ declared move allowed: ${where} --${event}--> ${cellWord(afterCell)}`;

/** The lines for one string list both machines hold, worded by `word`. */
const listDrift = (
  pair: MachinePair,
  list: (machine: DumpedMachine) => readonly string[],
  word: Readonly<Record<DriftSide, string>>,
): string[] => {
  const { after, before, id } = pair;
  return driftBetween(
    list(before),
    list(after),
    (value) => value,
    (side, item) => `${side} ${word[side]}: ${id}.${item}`,
  );
};

/** The lines for the declared seam. */
const jointDrift = (
  before: readonly DumpedJointState[],
  after: readonly DumpedJointState[],
): string[] =>
  driftBetween(
    before,
    after,
    jointStateKey,
    (side, state) =>
      `${side} joint invariant ${REMOVED_OR_ADDED[side]}: ${jointStateKey(state)}`,
  );

/** Every semantic change between two contract dumps, one line per change. */
export const driftLines = (base: Contracts, head: Contracts): string[] => {
  const lines: string[] = [];
  const ids = sortedStrings([
    ...unique([...Object.keys(base.machines), ...Object.keys(head.machines)]),
  ]);
  for (const id of ids) {
    const before = base.machines[id];
    const after = head.machines[id];
    if (before === undefined) {
      lines.push(`+ machine added: ${id}`);
      continue;
    }
    if (after === undefined) {
      lines.push(`- machine removed: ${id}`);
      continue;
    }
    const pair: MachinePair = { after, before, id };
    lines.push(...listDrift(pair, (machine) => machine.states, STATE_WORD));
    if (before.start !== after.start) {
      lines.push(`~ start moved: ${id}.${after.start} (was ${before.start})`);
    }
    lines.push(...edgeDrift(pair));
    lines.push(...declaredDrift(pair));
    lines.push(
      ...listDrift(pair, (machine) => machine.moneyEvents, MONEY_WORD),
    );
  }
  lines.push(...jointDrift(base.jointStates, head.jointStates));
  return lines;
};

/** The whole report: the header names the base ref, then one line per
 * change, or the clean sentence when nothing moved. */
export const formatDrift = (
  base: Contracts,
  head: Contracts,
  baseRef: string,
): string => {
  const lines = driftLines(base, head);
  if (lines.length === 0) return `No contract drift against ${baseRef}.`;
  return `Contract drift against ${baseRef}: ${lines.length} change(s)\n\n${lines.join(
    "\n",
  )}`;
};
