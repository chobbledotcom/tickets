/* jscpd:ignore-start -- imports */
import { filter, map, pipe, requiredMapValue, unique } from "#fp";
import { CLAIM_MIRROR } from "#payment/admit-move.ts";
import type {
  RefundAuthorityState,
  RefundRequestGeneration,
} from "#payment/refund-authority-state.ts";
import {
  REFUND_EVENTS,
  REFUND_NODES,
  refundNodeOf,
} from "#payment/refund-machine-spec.ts";
import { ROW_NODES } from "#payment/row-machine-spec.ts";
import {
  currentContracts,
  type DumpedMachine,
} from "#scripts/contract-drift/dump.ts";
import { tlaModule, tlaSet, tlaTuples } from "#scripts/verify-models/data.ts";
import { attemptTransition } from "#shared/schema-atlas/types.ts";

/* jscpd:ignore-end */

type Move = readonly [source: string, event: string, target: string];
type AuthorityMove = readonly [...Move, armed: boolean, requestKept: boolean];

export interface PaymentModel {
  readonly authorityMoves: readonly AuthorityMove[];
  readonly authorityStates: readonly string[];
  readonly claimedRows: readonly string[];
  readonly claimMirror: string;
  readonly rowMoves: readonly Move[];
  readonly rowStart: string;
  readonly rowStates: readonly string[];
  readonly sendAuthorityNames: readonly string[];
}

const movesOf = (machine: DumpedMachine): Move[] =>
  Object.entries(machine.edges).flatMap(([source, edges]) =>
    edges.map((edge): Move => [source, edge.event, edge.to]),
  );

const sameRequest = (
  before: RefundRequestGeneration,
  after: RefundRequestGeneration,
): boolean =>
  before.generation === after.generation &&
  before.identityIndex === after.identityIndex &&
  before.capability === after.capability &&
  (before.capability !== "keyed" ||
    (after.capability === "keyed" && before.replayUntil === after.replayUntil));

const appendRefundMoves = (
  node: string,
  state: RefundAuthorityState,
  authorityMoves: AuthorityMove[],
  sendAuthorityNames: string[],
): void => {
  for (const event of REFUND_EVENTS) {
    const next = attemptTransition(event.run, state);
    if (next === null) continue;
    authorityMoves.push([
      node,
      event.id,
      refundNodeOf(next),
      !event.movesMoney || next.kind === "send_armed",
      !event.movesMoney || sameRequest(state.request, next.request),
    ]);
    if (event.movesMoney) sendAuthorityNames.push(next.kind);
  }
};

const refundMoves = (start: string) => {
  const authorityMoves: AuthorityMove[] = [
    ["absent", "charge_created", start, true, true],
  ];
  const sendAuthorityNames: string[] = [];
  for (const node of REFUND_NODES) {
    for (const rep of node.reps) {
      appendRefundMoves(node.id, rep.state, authorityMoves, sendAuthorityNames);
    }
  }
  return { authorityMoves, sendAuthorityNames: unique(sendAuthorityNames) };
};

/** Run the production transitions. No stored copy supplies proof inputs. */
export const paymentModel = async (): Promise<PaymentModel> => {
  const machines = new Map(Object.entries((await currentContracts()).machines));
  const row = requiredMapValue(machines, "row", "The row machine is absent");
  const refund = requiredMapValue(
    machines,
    "refund",
    "The refund machine is absent",
  );
  const claimedRows = pipe(
    filter((node: (typeof ROW_NODES)[number]) => {
      const holds = node.reps.map(({ state }) => state.claim !== undefined);
      if (holds.some(Boolean) !== holds.every(Boolean)) {
        throw new Error(
          `Row node ${node.id} mixes claimed and unclaimed states`,
        );
      }
      return holds.every(Boolean);
    }),
    map((node) => node.id),
  )(ROW_NODES);
  const { authorityMoves, sendAuthorityNames } = refundMoves(refund.start);
  return {
    authorityMoves,
    authorityStates: ["absent", ...refund.states],
    claimedRows,
    claimMirror: CLAIM_MIRROR,
    rowMoves: movesOf(row),
    rowStart: row.start,
    rowStates: row.states,
    sendAuthorityNames,
  };
};

export const modelData = (model: PaymentModel): string =>
  tlaModule("JointStateData", [
    `RowStates == ${tlaSet(model.rowStates)}`,
    `AuthorityStates == ${tlaSet(model.authorityStates)}`,
    `ClaimedRows == ${tlaSet(model.claimedRows)}`,
    `RowStart == ${JSON.stringify(model.rowStart)}`,
    `\\* @type: Set(<<Str, Str, Str>>);\nRowMoves == ${tlaTuples(model.rowMoves)}`,
    `\\* @type: Set(<<Str, Str, Str, Bool, Bool>>);\nAuthMoves == ${tlaTuples(model.authorityMoves)}`,
  ]);
