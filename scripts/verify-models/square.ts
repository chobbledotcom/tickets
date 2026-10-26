/* jscpd:ignore-start -- imports */
import { map } from "#fp";
import {
  LINK_END_CHECKABLE_NODES,
  LINK_END_EVENTS,
  LINK_END_MOVES,
  LINK_END_NODES,
  SquareLinkEndStateSchema,
} from "#payment/square-link-end-machine-spec.ts";
import {
  collectMachineFacts,
  representativeFields,
} from "#scripts/verify-models/attempt.ts";
import {
  attemptFields,
  type ModelDataSource,
  type TlaFact,
  tlaModule,
  tlaRecords,
  tlaSet,
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

const linkRepresentativeFields = {
  ...representativeFields,
  storedState: "Str",
} as const;
const eventFields = {
  eventId: "Str",
  kind: "Str",
  movesMoney: "Bool",
} as const;
const replyFields = {
  eventId: "Str",
  expectedEvidence: "Str",
  sampleTag: "Str",
} as const;
const ageFields = {
  ageState: "Str",
  mayPay: "Bool",
  prunable: "Bool",
  requiredMarginElapsed: "Bool",
} as const;
const ageMoveFields = { sourceAge: "Str", targetAge: "Str" } as const;

type ReplyWitness = {
  sampleTag: string;
  expectedEvidence: "none" | "cancelled" | "missing" | "paid";
  status: number;
  text: string;
};

// Expected provider evidence must not be derived from the classifier's answer.
const replyWitnesses: readonly ReplyWitness[] = [
  {
    expectedEvidence: "cancelled",
    sampleTag: "cancelled",
    status: 200,
    text: '{"cancelled_order_id":"order"}',
  },
  {
    expectedEvidence: "missing",
    sampleTag: "missing",
    status: 404,
    text: '{"errors":[]}',
  },
  {
    expectedEvidence: "paid",
    sampleTag: "completed",
    status: 400,
    text: '{"errors":[{"code":"BAD_REQUEST","detail":"Order is COMPLETED and cannot be canceled"}]}',
  },
  {
    expectedEvidence: "paid",
    sampleTag: "paid",
    status: 409,
    text: '{"errors":[{"code":"ORDER_NOT_OPEN","detail":"Order has a PAID payment"}]}',
  },
  {
    expectedEvidence: "none",
    sampleTag: "success_without_id",
    status: 200,
    text: '{"id":"link"}',
  },
  {
    expectedEvidence: "none",
    sampleTag: "unreadable",
    status: 200,
    text: "not json",
  },
  {
    expectedEvidence: "none",
    sampleTag: "unpaid",
    status: 400,
    text: '{"errors":[{"code":"BAD_REQUEST","detail":"Order is UNPAID and cannot be canceled"}]}',
  },
  {
    expectedEvidence: "none",
    sampleTag: "unrelated_failure",
    status: 400,
    text: '{"errors":[{"code":"INVALID_VALUE","detail":"The field is wrong"}]}',
  },
];
const declared = movesIn(LINK_END_MOVES);

export const squareModelData: ModelDataSource = async () => {
  const facts = collectMachineFacts(
    LINK_END_NODES,
    LINK_END_EVENTS,
    declared,
    (state) => ({ storedState: state.state }),
    (representative, event, target): TlaFact<typeof attemptFields> => ({
      accepted: target !== null,
      eventId: event.id,
      sampleTag: representative.tag,
      sourceState: representative.state.state,
      targetState: target === null ? representative.state.state : target.state,
    }),
  );
  const replyFacts = map(
    (witness: ReplyWitness): TlaFact<typeof replyFields> => {
      const answer: FetchResult = {
        headers: new Headers(),
        ok: witness.status >= 200 && witness.status < 300,
        status: witness.status,
        text: witness.text,
      };
      return {
        eventId: squareLinkEndEventOf(answer),
        expectedEvidence: witness.expectedEvidence,
        sampleTag: witness.sampleTag,
      };
    },
  )(replyWitnesses);

  // The required margin is independent of the actual retention cutoff.
  const expectedMargin =
    SQUARE_NATIVE_LIFETIME_MS + WEBHOOK_RETRY_WINDOW_DAYS * DAY_MS;
  const ages = [
    { ageState: "zero", milliseconds: 0 },
    { ageState: "native_before", milliseconds: SQUARE_NATIVE_LIFETIME_MS - 1 },
    { ageState: "native_at", milliseconds: SQUARE_NATIVE_LIFETIME_MS },
    { ageState: "native_after", milliseconds: SQUARE_NATIVE_LIFETIME_MS + 1 },
    {
      ageState: "retention_before",
      milliseconds: SQUARE_LINK_RETENTION_MS - 1,
    },
    { ageState: "retention_at", milliseconds: SQUARE_LINK_RETENTION_MS },
    { ageState: "retention_after", milliseconds: SQUARE_LINK_RETENTION_MS + 1 },
    { ageState: "margin_before", milliseconds: expectedMargin - 1 },
    { ageState: "margin_at", milliseconds: expectedMargin },
    { ageState: "margin_after", milliseconds: expectedMargin + 1 },
  ];
  const ageFacts = map(
    (age: (typeof ages)[number]): TlaFact<typeof ageFields> => ({
      ageState: age.ageState,
      mayPay: age.milliseconds < SQUARE_NATIVE_LIFETIME_MS,
      prunable: age.milliseconds > SQUARE_LINK_RETENTION_MS,
      requiredMarginElapsed: age.milliseconds > expectedMargin,
    }),
  )(ages);
  const ageMoves: TlaFact<typeof ageMoveFields>[] = [];
  for (const source of ages) {
    for (const target of ages) {
      if (source.milliseconds <= target.milliseconds) {
        ageMoves.push({
          sourceAge: source.ageState,
          targetAge: target.ageState,
        });
      }
    }
  }
  const events = map(
    (event: (typeof LINK_END_EVENTS)[number]): TlaFact<typeof eventFields> => ({
      eventId: event.id,
      kind: event.kind,
      movesMoney: event.movesMoney,
    }),
  )(LINK_END_EVENTS);
  return tlaModule("SquareLinkEndData", [
    `LinkStates == ${tlaSet(map((node: (typeof LINK_END_NODES)[number]) => node.id)(LINK_END_NODES))}`,
    `HandleStates == ${tlaSet(SquareLinkEndStateSchema.options)}`,
    `CheckableStates == ${tlaSet(LINK_END_CHECKABLE_NODES)}`,
    tlaRecords(
      "LinkRepresentatives",
      linkRepresentativeFields,
      facts.representatives,
    ),
    tlaRecords("LinkEvents", eventFields, events),
    tlaRecords("LinkAttempts", attemptFields, facts.attempts),
    tlaRecords("ReplyFacts", replyFields, replyFacts),
    `AgeStates == ${tlaSet(map((age: (typeof ages)[number]) => age.ageState)(ages))}`,
    'AgeStart == "zero"',
    tlaRecords("AgeFacts", ageFields, ageFacts),
    tlaRecords("AgeMoves", ageMoveFields, ageMoves),
  ]);
};
