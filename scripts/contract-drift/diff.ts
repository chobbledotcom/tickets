/** The semantic diff between two contract dumps: which machine moves,
 * money flags, and joint-state invariants changed. Pure data in, report
 * lines out, so the tests pin every change kind. */

import { unique } from "#fp";
import {
  type Contracts,
  type DumpedJointState,
  type DumpedMachine,
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

/** The lines for one machine's moves. */
const edgeDrift = ({ after, before, id }: MachinePair): string[] => {
  const rowsBefore = edgeRows(before);
  const rowsAfter = edgeRows(after);
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
};
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
