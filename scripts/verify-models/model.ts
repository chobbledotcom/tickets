import { filter, map, pipe, requiredMapValue, unique } from "#fp";
import { CLAIM_MIRROR } from "#payment/admit-move.ts";
import { REFUND_NODES } from "#payment/refund-machine-spec.ts";
import { ROW_NODES } from "#payment/row-machine-spec.ts";
import {
  currentContracts,
  type DumpedMachine,
} from "#scripts/contract-drift/dump.ts";

type Move = readonly [source: string, event: string, target: string];

export interface PaymentModel {
  readonly authorityMoves: readonly Move[];
  readonly authorityStates: readonly string[];
  readonly claimedRows: readonly string[];
  readonly claimMirror: string;
  readonly rowMoves: readonly Move[];
  readonly rowStart: string;
  readonly rowStates: readonly string[];
  readonly sendAuthorityNames: readonly string[];
  readonly sendEvents: readonly string[];
}

const movesOf = (machine: DumpedMachine): Move[] =>
  Object.entries(machine.edges).flatMap(([source, edges]) =>
    edges.map((edge): Move => [source, edge.event, edge.to]),
  );

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
  const authorityMoves: Move[] = [
    ["absent", "charge_created", refund.start],
    ...movesOf(refund),
  ];
  const sendTargets = pipe(
    filter((move: Move) => refund.moneyEvents.includes(move[1])),
    map((move) => move[2]),
    unique,
  )(authorityMoves);
  const sendAuthorityNames = pipe(
    filter((node: (typeof REFUND_NODES)[number]) =>
      sendTargets.includes(node.id),
    ),
    map((node) => node.reps.map(({ state }) => state.kind)),
  )(REFUND_NODES).flat();
  return {
    authorityMoves,
    authorityStates: ["absent", ...refund.states],
    claimedRows,
    claimMirror: CLAIM_MIRROR,
    rowMoves: movesOf(row),
    rowStart: row.start,
    rowStates: row.states,
    sendAuthorityNames: unique(sendAuthorityNames),
    sendEvents: refund.moneyEvents,
  };
};

/** Render only controlled state and event names from the production tables. */
export const modelData = (model: PaymentModel): string => {
  const set = (values: readonly string[]): string =>
    `{${values.map((value) => JSON.stringify(value)).join(", ")}}`;
  const moves = (values: readonly Move[]): string =>
    `{\n${values.map((move) => `  <<${move.map((part) => JSON.stringify(part)).join(", ")}>>`).join(",\n")}\n}`;
  return `---- MODULE JointStateData ----
RowStates == ${set(model.rowStates)}
AuthorityStates == ${set(model.authorityStates)}
ClaimedRows == ${set(model.claimedRows)}
SendEvents == ${set(model.sendEvents)}
RowStart == ${JSON.stringify(model.rowStart)}
\\* @type: Set(<<Str, Str, Str>>);
RowMoves == ${moves(model.rowMoves)}
\\* @type: Set(<<Str, Str, Str>>);
AuthMoves == ${moves(model.authorityMoves)}
====
`;
};
