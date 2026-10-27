/* jscpd:ignore-start -- imports */
import { filter, map, pipe, requiredMapValue, unique } from "#fp";
import { CLAIM_MIRROR } from "#payment/admit-move.ts";
import { refundLifecycleFor } from "#payment/refund-authority-lifecycle.ts";
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
import {
  moveFields,
  type TlaFact,
  tlaModule,
  tlaRecords,
  tlaSet,
} from "#scripts/verify-models/data.ts";
import { attemptTransition } from "#shared/schema-atlas/types.ts";

/* jscpd:ignore-end */

const authorityMoveFields = {
  ...moveFields,
  armed: "Bool",
  inWindow: "Bool",
  keyed: "Bool",
  movesMoney: "Bool",
  replay: "Bool",
  requestKept: "Bool",
} as const;
type Move = TlaFact<typeof moveFields>;
type AuthorityMove = TlaFact<typeof authorityMoveFields>;

export interface PaymentModel {
  readonly authorityMoves: readonly AuthorityMove[];
  readonly authorityStates: readonly string[];
  readonly claimedRows: readonly string[];
  readonly claimMirror: string;
  readonly moneyEventIds: readonly string[];
  readonly prunableStates: readonly string[];
  readonly rowMoves: readonly Move[];
  readonly rowStart: string;
  readonly rowStates: readonly string[];
  readonly sendAuthorityNames: readonly string[];
}

const movesOf = (machine: DumpedMachine): Move[] =>
  Object.entries(machine.edges).flatMap(([source, edges]) =>
    edges.map(
      (edge): Move => ({
        eventId: edge.event,
        sourceState: source,
        targetState: edge.to,
      }),
    ),
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

/** Node ids whose representatives all share one flag, or throw on a mix.
 * `holder` is the machine's plain name, `field` the two states being told
 * apart, so a mixed node names itself in the error. */
const nodeIdsWhere = <State>(
  nodes: readonly { id: string; reps: readonly { state: State }[] }[],
  holder: string,
  field: string,
  holds: (state: State) => boolean,
): string[] =>
  pipe(
    filter((node: { id: string; reps: readonly { state: State }[] }) => {
      const values = node.reps.map(({ state }) => holds(state));
      if (values.some(Boolean) !== values.every(Boolean)) {
        throw new Error(`${holder} node ${node.id} mixes ${field}`);
      }
      return values.every(Boolean);
    }),
    map((node) => node.id),
  )(nodes);

/** Whether a send lands inside the keyed request's replay window. The
 * deadline itself is inside: the window closes only strictly past it. */
const inWindowOf = (
  state: RefundAuthorityState,
  next: RefundAuthorityState,
): boolean => {
  if (state.request.capability !== "keyed") return true;
  if (next.kind !== "send_armed") return true;
  return next.armedAt <= state.request.replayUntil;
};

const appendRefundMoves = (
  node: string,
  state: RefundAuthorityState,
  authorityMoves: AuthorityMove[],
  moneyEventIds: string[],
  sendAuthorityNames: string[],
): void => {
  for (const event of REFUND_EVENTS) {
    const next = attemptTransition(event.run, state);
    if (next === null) continue;
    authorityMoves.push({
      armed: !event.movesMoney || next.kind === "send_armed",
      eventId: event.id,
      inWindow: inWindowOf(state, next),
      keyed: state.request.capability === "keyed",
      movesMoney: event.movesMoney,
      replay: event.id === "replay",
      requestKept:
        !event.movesMoney || sameRequest(state.request, next.request),
      sourceState: node,
      targetState: refundNodeOf(next),
    });
    if (event.movesMoney) {
      moneyEventIds.push(event.id);
      sendAuthorityNames.push(next.kind);
    }
  }
};

const refundMoves = (start: string) => {
  const authorityMoves: AuthorityMove[] = [
    {
      armed: true,
      eventId: "charge_created",
      inWindow: true,
      keyed: false,
      movesMoney: false,
      replay: false,
      requestKept: true,
      sourceState: "absent",
      targetState: start,
    },
  ];
  const sendAuthorityNames: string[] = [];
  const moneyEventIds: string[] = [];
  for (const node of REFUND_NODES) {
    for (const rep of node.reps) {
      appendRefundMoves(
        node.id,
        rep.state,
        authorityMoves,
        moneyEventIds,
        sendAuthorityNames,
      );
    }
  }
  return {
    authorityMoves,
    moneyEventIds: unique(moneyEventIds),
    sendAuthorityNames: unique(sendAuthorityNames),
  };
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
  const claimedRows = nodeIdsWhere(
    ROW_NODES,
    "Row",
    "claimed and unclaimed states",
    (state) => state.claim !== undefined,
  );
  const { authorityMoves, moneyEventIds, sendAuthorityNames } = refundMoves(
    refund.start,
  );
  // A refund state is eligible for deletion only when the lifecycle declares
  // it prunable: completed and locally recorded. Every representative of one
  // node must agree.
  const prunableRefundStates = nodeIdsWhere(
    REFUND_NODES,
    "Refund",
    "prunable and unprunable states",
    (state) => refundLifecycleFor(state).prunable,
  );
  return {
    authorityMoves,
    authorityStates: ["absent", ...refund.states],
    claimedRows,
    claimMirror: CLAIM_MIRROR,
    moneyEventIds,
    prunableStates: ["absent", ...prunableRefundStates],
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
    `PrunableStates == ${tlaSet(model.prunableStates)}`,
    `RowStart == ${JSON.stringify(model.rowStart)}`,
    tlaRecords("RowMoves", moveFields, model.rowMoves),
    tlaRecords("AuthMoves", authorityMoveFields, model.authorityMoves),
  ]);
