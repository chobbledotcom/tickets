/** Shared executors for machine-spec mirror tests: the conformance sweep,
 * the table-shape checks, and the exports-drive-the-spec guard every
 * machine runs the same way. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  type MachineEvent,
  type MachineMoves,
  type MachineNode,
  type MachineRepresentative,
  movesIn,
} from "#shared/schema-atlas/machine-spec.ts";

/** Everything one machine's mirror test hands the shared executors. */
export type MachineSpec<
  State,
  NodeId extends string,
  EventId extends string,
> = {
  readonly events: readonly MachineEvent<State, EventId>[];
  /** Laws every successful move must keep, asserted on each swept cell —
   * e.g. a value that may never change, or a counter that only grows. */
  readonly invariants?: (source: State, result: State, cell: string) => void;
  readonly moves: MachineMoves<NodeId, EventId>;
  readonly nodeOf: (state: State) => NodeId;
  readonly nodes: readonly MachineNode<State, NodeId>[];
};

/** Runs one cell and asserts the exact move the table declares for it. */
const checkCell = <State, NodeId extends string, EventId extends string>(
  spec: MachineSpec<State, NodeId, EventId>,
  node: MachineNode<State, NodeId>,
  event: MachineEvent<State, EventId>,
  rep: MachineRepresentative<State>,
): void => {
  const cell = `${node.id} × ${event.id} [${rep.tag}]`;
  const want = movesIn(spec.moves).expected(node.id, event.id, rep.tag);
  if (want === "refused") {
    expectRefusal(() => event.run(rep.state), cell);
  } else {
    const result = event.run(rep.state);
    expect(spec.nodeOf(result), cell).toBe(want);
    spec.invariants?.(rep.state, result, cell);
  }
};

/** A refusal must be an Error that says why — a blank refusal would leave
 * an operator with nothing to act on. */
const expectRefusal = (run: () => unknown, cell: string): void => {
  let refusal: unknown = null;
  try {
    run();
  } catch (error) {
    refusal = error;
  }
  expect(refusal instanceof Error, `${cell} must refuse`).toBe(true);
  if (refusal instanceof Error) {
    expect(
      refusal.message.length,
      `${cell} refusal must say why`,
    ).toBeGreaterThan(0);
  }
};

/** Registers one test per node: every event runs against every one of its
 * shapes and must land where the table says — or throw, when the cell is
 * absent. Call inside a describe. */
export const registerConformanceSweep = <
  State,
  NodeId extends string,
  EventId extends string,
>(
  spec: MachineSpec<State, NodeId, EventId>,
): void => {
  for (const node of spec.nodes) {
    test(`${node.id} answers every event for each of its shapes`, () => {
      for (const event of spec.events) {
        for (const rep of node.reps) {
          checkCell(spec, node, event, rep);
        }
      }
    });
  }
};

/** The whole-table size, pinned so a silently shrunk shape family or event
 * list cannot pass as "all cells still conform". */
export type MachinePins = {
  readonly events: number;
  readonly nodes: number;
  readonly shapes: number;
};

/** Registers the table-shape checks shared by every machine: pinned sizes,
 * shapes sitting on their own node, real targets, and split cells naming
 * only shapes their node has. Call inside a describe. */
export const registerTableChecks = <
  State,
  NodeId extends string,
  EventId extends string,
>(
  spec: MachineSpec<State, NodeId, EventId>,
  pins: MachinePins,
): void => {
  const reader = movesIn(spec.moves);

  test(`the sweep's size is pinned: ${pins.nodes} nodes × ${pins.events} events over ${pins.shapes} shapes`, () => {
    expect(spec.nodes.length).toBe(pins.nodes);
    expect(spec.events.length).toBe(pins.events);
    expect(
      spec.nodes.reduce((total, node) => total + node.reps.length, 0),
    ).toBe(pins.shapes);
    const eventIds = spec.events.map(({ id }) => id);
    expect([...new Set(eventIds)]).toEqual(eventIds);
  });

  test("every shape sits on the node it stands for", () => {
    for (const node of spec.nodes) {
      const tags = node.reps.map(({ tag }) => tag);
      expect([...new Set(tags)], node.id).toEqual(tags);
      for (const { state, tag } of node.reps) {
        expect(spec.nodeOf(state), `${node.id} [${tag}]`).toBe(node.id);
      }
    }
  });

  test("the table answers exactly the declared nodes with real targets", () => {
    const nodeIds = spec.nodes.map(({ id }) => id);
    expect([...new Set(nodeIds)]).toEqual(nodeIds);
    expect(Object.keys(spec.moves).sort()).toEqual([...nodeIds].sort());
    const known = new Set<string>(nodeIds);
    for (const node of spec.nodes) {
      for (const event of spec.events) {
        for (const target of reader.targets(node.id, event.id)) {
          expect(
            known.has(target),
            `${node.id} × ${event.id} -> ${target}`,
          ).toBe(true);
        }
      }
    }
  });

  test("a split cell names only shapes its node actually has", () => {
    for (const node of spec.nodes) {
      const tags = new Set(node.reps.map(({ tag }) => tag));
      for (const event of spec.events) {
        for (const tag of reader.splitTags(node.id, event.id)) {
          expect(
            tags.has(tag),
            `${node.id} × ${event.id} splits on unknown [${tag}]`,
          ).toBe(true);
        }
      }
    }
  });
};

/** One module whose exports the machine spec must drive: its filename, and
 * the exports that are deliberately not transitions, each named with the
 * check that covers it instead. */
export type DrivenModule = {
  readonly file: string;
  readonly notTransitions: Readonly<Record<string, string>>;
};

/** Registers the guard that keeps a machine spec honest about its surface:
 * every `export const` of each named module must be imported by the spec
 * module (an import is a real binding — an unused one fails lint), so a new
 * transition stays red here until the table models it. Call inside a
 * describe. */
export const registerDrivenExportsCheck = (
  sourceDir: string,
  specFile: string,
  modules: readonly DrivenModule[],
): void => {
  test("every exported transition drives the machine spec", async () => {
    const spec = await Deno.readTextFile(`${sourceDir}/${specFile}`);
    for (const { file, notTransitions } of modules) {
      const source = await Deno.readTextFile(`${sourceDir}/${file}`);
      const names = [...source.matchAll(/^export const (\w+)/gm)].map(
        (match) => match[1]!,
      );
      expect(names.length, file).toBeGreaterThan(0);
      for (const name of names) {
        if (name in notTransitions) continue;
        const imported = new RegExp(
          `import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*"[^"]*/${file}"`,
        ).test(spec);
        expect(
          imported,
          `${file} exports ${name} but the machine spec never imports it`,
        ).toBe(true);
      }
    }
  });
};
