/* jscpd:ignore-start -- imports */
import { map } from "#fp";
import {
  LINK_END_CHECKABLE_NODES,
  LINK_END_EVENTS,
  LINK_END_MOVES,
  LINK_END_NODES,
  SquareLinkEndStateSchema,
} from "#payment/square-link-end-machine-spec.ts";
import { collectMachineFacts } from "#scripts/verify-models/attempt.ts";
import {
  type ModelDataSource,
  tlaModule,
  tlaSet,
  tlaTuples,
} from "#scripts/verify-models/data.ts";
import type { FetchResult } from "#shared/fetch.ts";
import { WEBHOOK_RETRY_WINDOW_DAYS } from "#shared/limits.ts";
import { DAY_MS } from "#shared/now.ts";
import { movesIn } from "#shared/schema-atlas/machine-spec.ts";
import {
  SQUARE_LINK_RETENTION_MS,
  SQUARE_NATIVE_LIFETIME_MS,
} from "#shared/square/limits.ts";
import { squareLinkEndEventOf } from "#shared/square/link-end.ts";

/* jscpd:ignore-end */

type RepresentativeFact = readonly [state: string];
type AttemptFact = readonly [
  source: string,
  event: string,
  target: string,
  tag: string,
  accepted: boolean,
];
type ReplyWitness = readonly [
  label: string,
  evidence: "none" | "cancelled" | "missing" | "paid",
  status: number,
  text: string,
];

// These are provider-contract witnesses, not expectations derived from the
// classifier's event names. The observed event remains separate in ReplyFacts.
const replyWitnesses: readonly ReplyWitness[] = [
  ["cancelled", "cancelled", 200, '{"cancelled_order_id":"order"}'],
  ["missing", "missing", 404, '{"errors":[]}'],
  [
    "completed",
    "paid",
    400,
    '{"errors":[{"code":"BAD_REQUEST","detail":"Order is COMPLETED and cannot be canceled"}]}',
  ],
  [
    "paid",
    "paid",
    409,
    '{"errors":[{"code":"ORDER_NOT_OPEN","detail":"Order has a PAID payment"}]}',
  ],
  ["success_without_id", "none", 200, '{"id":"link"}'],
  ["unreadable", "none", 200, "not json"],
  [
    "unpaid",
    "none",
    400,
    '{"errors":[{"code":"BAD_REQUEST","detail":"Order is UNPAID and cannot be canceled"}]}',
  ],
  [
    "unrelated_failure",
    "none",
    400,
    '{"errors":[{"code":"INVALID_VALUE","detail":"The field is wrong"}]}',
  ],
];
const declared = movesIn(LINK_END_MOVES);

/** A failed declared move is not a refusal. Clone each input so a changed
 * argument cannot erase the source evidence. */
export const squareModelData: ModelDataSource = async () => {
  const facts = collectMachineFacts(
    LINK_END_NODES,
    LINK_END_EVENTS,
    declared,
    (state): RepresentativeFact => [state.state],
    (representative, event, target): AttemptFact => [
      representative.state.state,
      event.id,
      target === null ? representative.state.state : target.state,
      representative.tag,
      target !== null,
    ],
  );
  const replyFacts = map(
    ([label, evidence, status, text]: ReplyWitness): readonly [
      string,
      string,
      string,
    ] => {
      const answer: FetchResult = {
        headers: new Headers(),
        ok: status >= 200 && status < 300,
        status,
        text,
      };
      return [label, evidence, squareLinkEndEventOf(answer)];
    },
  )(replyWitnesses);

  // Keep the expected margin independent. An unsafe retention change must not
  // redefine the property that checks it.
  const expectedMargin =
    SQUARE_NATIVE_LIFETIME_MS + WEBHOOK_RETRY_WINDOW_DAYS * DAY_MS;
  const ages: readonly (readonly [string, number])[] = [
    ["zero", 0],
    ["native_before", SQUARE_NATIVE_LIFETIME_MS - 1],
    ["native_at", SQUARE_NATIVE_LIFETIME_MS],
    ["native_after", SQUARE_NATIVE_LIFETIME_MS + 1],
    ["retention_before", SQUARE_LINK_RETENTION_MS - 1],
    ["retention_at", SQUARE_LINK_RETENTION_MS],
    ["retention_after", SQUARE_LINK_RETENTION_MS + 1],
    ["margin_before", expectedMargin - 1],
    ["margin_at", expectedMargin],
    ["margin_after", expectedMargin + 1],
  ];
  const ageFacts = map(
    ([label, age]: readonly [string, number]): readonly [
      string,
      boolean,
      boolean,
      boolean,
    ] => [
      label,
      age < SQUARE_NATIVE_LIFETIME_MS,
      age > SQUARE_LINK_RETENTION_MS,
      age > expectedMargin,
    ],
  )(ages);
  const ageMoves: (readonly [string, string])[] = [];
  for (const [source, fromAge] of ages) {
    for (const [target, toAge] of ages) {
      if (fromAge <= toAge) ageMoves.push([source, target]);
    }
  }
  const events = map(
    (
      event: (typeof LINK_END_EVENTS)[number],
    ): readonly [string, string, boolean] => [
      event.id,
      event.kind,
      event.movesMoney,
    ],
  )(LINK_END_EVENTS);
  return tlaModule("SquareLinkEndData", [
    `LinkStates == ${tlaSet(map((node: (typeof LINK_END_NODES)[number]) => node.id)(LINK_END_NODES))}`,
    `HandleStates == ${tlaSet(SquareLinkEndStateSchema.options)}`,
    `CheckableStates == ${tlaSet(LINK_END_CHECKABLE_NODES)}`,
    `\\* @type: Set(<<Str, Str, Str>>);\nLinkRepresentatives == ${tlaTuples(facts.representatives)}`,
    `\\* @type: Set(<<Str, Str, Bool>>);\nLinkEvents == ${tlaTuples(events)}`,
    `\\* @type: Set(<<Str, Str, Str, Str, Bool>>);\nLinkAttempts == ${tlaTuples(facts.attempts)}`,
    `\\* @type: Set(<<Str, Str, Str>>);\nReplyFacts == ${tlaTuples(replyFacts)}`,
    `AgeStates == ${tlaSet(map(([label]: readonly [string, number]) => label)(ages))}`,
    'AgeStart == "zero"',
    `\\* @type: Set(<<Str, Bool, Bool, Bool>>);\nAgeFacts == ${tlaTuples(ageFacts)}`,
    `\\* @type: Set(<<Str, Str>>);\nAgeMoves == ${tlaTuples(ageMoves)}`,
  ]);
};
