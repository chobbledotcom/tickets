/** Executes the whole refund machine table: every (node × event ×
 * representative) cell runs the real transition and must land where the
 * table says — or throw, when the cell is absent. The suite then proves the
 * table itself is complete: the sweep's size is pinned, split cells name
 * real shapes, owner exits match the choices module, and every exported
 * transition drives at least one event. */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { sumOf } from "#fp";
import {
  type RefundOwnerChoiceName,
  refundOwnerChoices,
} from "#shared/payment/refund-authority-choice.ts";
import {
  EXPECTED_MOVES,
  expectedMove,
  REFUND_EVENTS,
  REFUND_NODES,
  type RefundEventId,
  type RefundMachineEvent,
  type RefundNode,
  type RefundRepresentative,
  refundNodeOf,
} from "#shared/payment/refund-machine-spec.ts";

const paymentSourceDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../src/shared/payment",
);

/** Runs one cell and asserts the exact move the table declares for it. */
const checkCell = (
  node: RefundNode,
  event: RefundMachineEvent,
  rep: RefundRepresentative,
): void => {
  const cell = `${node.id} × ${event.id} [${rep.tag}]`;
  const want = expectedMove(node.id, event.id, rep.tag);
  if (want === "refused") {
    expect(() => event.run(rep.state), cell).toThrow();
  } else {
    expect(refundNodeOf(event.run(rep.state)), cell).toBe(want);
  }
};

describe("the refund machine table", () => {
  describe("cell conformance — every event against every stored shape", () => {
    for (const node of REFUND_NODES) {
      test(`${node.id} answers every event for each of its shapes`, () => {
        let executed = 0;
        for (const event of REFUND_EVENTS) {
          for (const rep of node.reps) {
            executed++;
            checkCell(node, event, rep);
          }
        }
        expect(executed).toBe(REFUND_EVENTS.length * node.reps.length);
      });
    }
  });

  test("the sweep's size is pinned: 9 nodes × 15 events over 28 shapes", () => {
    expect(REFUND_NODES.length).toBe(9);
    expect(REFUND_EVENTS.length).toBe(15);
    expect(
      sumOf((node: (typeof REFUND_NODES)[number]) => node.reps.length)(
        REFUND_NODES,
      ),
    ).toBe(28);
    const eventIds = REFUND_EVENTS.map(({ id }) => id);
    expect([...new Set(eventIds)]).toEqual(eventIds);
  });

  test("every representative sits on the node it stands for", () => {
    for (const node of REFUND_NODES) {
      const tags = node.reps.map(({ tag }) => tag);
      expect([...new Set(tags)], node.id).toEqual(tags);
      for (const { state, tag } of node.reps) {
        expect(refundNodeOf(state), `${node.id} [${tag}]`).toBe(node.id);
      }
    }
  });

  test("the representatives cover every stored state kind", () => {
    const kinds = new Set(
      REFUND_NODES.flatMap(({ reps }) => reps.map(({ state }) => state.kind)),
    );
    expect([...kinds].sort()).toEqual([
      "completed",
      "needs_owner_choice",
      "needs_provider_check",
      "observing",
      "ready",
      "send_armed",
    ]);
  });

  test("the table answers exactly the declared nodes with real targets", () => {
    const nodeIds = REFUND_NODES.map(({ id }) => id);
    expect([...new Set(nodeIds)]).toEqual(nodeIds);
    expect(Object.keys(EXPECTED_MOVES).sort()).toEqual([...nodeIds].sort());
    const known = new Set<string>(nodeIds);
    for (const node of REFUND_NODES) {
      for (const [eventId, move] of Object.entries(EXPECTED_MOVES[node.id])) {
        const targets =
          typeof move === "string"
            ? [move]
            : Object.values(move.perRep).filter(
                (target) => target !== undefined,
              );
        for (const target of targets) {
          expect(
            known.has(target),
            `${node.id} × ${eventId} -> ${target}`,
          ).toBe(true);
        }
      }
    }
  });

  test("a split cell names only shapes its node actually has", () => {
    for (const node of REFUND_NODES) {
      const tags = new Set(node.reps.map(({ tag }) => tag));
      for (const [eventId, move] of Object.entries(EXPECTED_MOVES[node.id])) {
        if (typeof move === "string") continue;
        for (const tag of Object.keys(move.perRep)) {
          expect(
            tags.has(tag),
            `${node.id} × ${eventId} splits on unknown [${tag}]`,
          ).toBe(true);
        }
      }
    }
  });

  test("recorded is terminal: the table declares no move out of it", () => {
    expect(EXPECTED_MOVES.recorded).toEqual({});
  });

  test("only the two sends move money", () => {
    expect(
      REFUND_EVENTS.filter(({ movesMoney }) => movesMoney).map(({ id }) => id),
    ).toEqual(["arm", "replay"]);
  });

  test("the table's owner exits are exactly the choices the code admits", () => {
    const OWNER_EVENTS: readonly (readonly [
      RefundOwnerChoiceName,
      RefundEventId,
    ])[] = [
      ["provider_confirmed_not_sent", "owner_confirms_not_sent"],
      ["provider_confirmed_returned", "owner_confirms_returned"],
    ];
    let checkedShapes = 0;
    for (const node of REFUND_NODES) {
      for (const { state, tag } of node.reps) {
        if (state.kind !== "needs_owner_choice") continue;
        checkedShapes++;
        const admitted = refundOwnerChoices(state);
        for (const [choice, eventId] of OWNER_EVENTS) {
          expect(
            expectedMove(node.id, eventId, tag) !== "refused",
            `${node.id} [${tag}] ${choice}`,
          ).toBe(admitted.includes(choice));
        }
      }
    }
    // choice_open's four shapes plus three each behind the two settled
    // conflict decisions.
    expect(checkedShapes).toBe(10);
  });

  test("every exported transition drives the machine spec", async () => {
    // Exports that are not transitions, each named with the check that
    // covers it instead.
    const NOT_TRANSITIONS: Readonly<Record<string, string>> = {
      refundOwnerChoices:
        "a query — executed by the owner-exit derivation test above",
      requireActiveSentRefund:
        "a guard inside transitions — every armed-only refusal in the sweep exercises it",
    };
    const spec = await Deno.readTextFile(
      join(paymentSourceDir, "refund-machine-spec.ts"),
    );
    for (const module of [
      "refund-authority.ts",
      "refund-authority-choice.ts",
    ]) {
      const source = await Deno.readTextFile(join(paymentSourceDir, module));
      const names = [...source.matchAll(/^export const (\w+)/gm)].map(
        (match) => match[1]!,
      );
      expect(names.length, module).toBeGreaterThan(0);
      for (const name of names) {
        if (name in NOT_TRANSITIONS) continue;
        expect(
          spec.includes(name),
          `${module} exports ${name} but the machine spec never drives it`,
        ).toBe(true);
      }
    }
  });
});
