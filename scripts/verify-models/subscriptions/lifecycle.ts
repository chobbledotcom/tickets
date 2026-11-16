/** Subscription lifecycle evidence. No provider call or database runs at import. */
import { tlaModule, tlaSet } from "#scripts/verify-models/data.ts";
import {
  producerFor,
  recordSetsFor,
} from "#scripts/verify-models/subscriptions/controls.ts";
import {
  LIFECYCLE_TABLES,
  type LifecycleFacts,
  lifecycleCases,
} from "#scripts/verify-models/subscriptions/lifecycle-facts.ts";
import { lifecycleMoves } from "#scripts/verify-models/subscriptions/lifecycle-run.ts";
import { SubscriptionStatusSchema } from "#shared/subscriptions/plan.ts";

/** Each call executes anew. A control cannot reuse clean cached output. */
export const lifecycleFacts = async (): Promise<LifecycleFacts> => ({
  moves: await lifecycleMoves(lifecycleCases()),
});

const recordSets = recordSetsFor(LIFECYCLE_TABLES);

/** The expected count comes from the case list, not from the observed moves. */
const moduleFor = (facts: LifecycleFacts): string =>
  tlaModule("SubscriptionLifecycleData", [
    `Statuses == ${tlaSet(SubscriptionStatusSchema.options)}`,
    `ExpectedMovesCount == ${lifecycleCases().length}`,
    ...recordSets(facts),
  ]);

const LAST_RENEWAL = "check/answers/active/canceled/1/0";

/** Each row names a control, the field it corrupts, the wrong text for a
 * text field, and the move it changes. */
/* jscpd:ignore-start -- a list of strings, not code */
const FIELD_FAULTS = [
  [
    "local end before the Stripe end",
    "storedAfter",
    "canceled",
    "check/answers/active/active/0/0",
  ],
  [
    "renewal recorded twice",
    "recordedAfter",
    "",
    "check/answers/active/active/1/1",
  ],
  [
    "ended row opened again",
    "storedAfter",
    "active",
    "check/answers/canceled/canceled/0/0",
  ],
  [
    "cancelled answer without an end",
    "outcome",
    "cancelled",
    "cancel/subscription-refused/active/active/0/0",
  ],
] as const;
/* jscpd:ignore-end */

export const { controls, modelData } = producerFor(
  lifecycleFacts,
  moduleFor,
  (facts) => facts,
  {
    fields: FIELD_FAULTS.map(([name, field, wrongText, scenario]) => [
      name,
      "moves",
      field,
      wrongText,
      { scenario },
    ]),
    missing: [
      [
        "missing lifecycle move",
        "initial",
        "moves",
        { scenario: "cancel/answers/active/active/0/0" },
      ],
    ],
  },
  (changedData) => [
    {
      data: changedData((facts) => {
        facts.moves = facts.moves.map((fact) =>
          fact.scenario === LAST_RENEWAL ? { ...fact, recordedAfter: 0 } : fact,
        );
      }),
      name: "end before the last renewal",
      phase: "step",
    },
  ],
);
