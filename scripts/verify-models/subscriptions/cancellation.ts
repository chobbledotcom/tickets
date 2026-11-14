/** Subscription cancellation evidence. No provider call or database runs at import. */
import { tlaModule, tlaSet } from "#scripts/verify-models/data.ts";
import type { ModelControl } from "#scripts/verify-models/spec.ts";
import { checkoutFacts } from "#scripts/verify-models/subscriptions/cancellation-checkout.ts";
import {
  CANCELLATION_TABLES,
  type CancellationFacts,
  type CancellationFault,
} from "#scripts/verify-models/subscriptions/cancellation-facts.ts";
import {
  guardedWriteFacts,
  ownerFacts,
} from "#scripts/verify-models/subscriptions/cancellation-owner.ts";
import {
  producerFor,
  recordSetsFor,
} from "#scripts/verify-models/subscriptions/controls.ts";
import { SubscriptionStatusSchema } from "#shared/subscriptions/plan.ts";

/** Each call executes anew. Fault controls cannot reuse clean cached output. */
export const cancellationFacts = async (
  fault: CancellationFault = "none",
): Promise<CancellationFacts> => {
  const owners = await ownerFacts(fault);
  const writes = await guardedWriteFacts(fault);
  const checkouts = await checkoutFacts(fault);
  return { checkouts, owners, writes };
};

/** These input identities are separate from returned rows. Missing cases fail
 * initial safety, rather than disappear from the transition relation. */
const ownerScenarios = [
  "owner-final",
  "owner-read-ended",
  "owner-both-refused",
  "owner-invoice-refused",
  "owner-both-missing",
  "owner-both-unavailable",
  "owner-invoice-missing",
  "owner-invoice-unavailable",
  "owner-ledger-fault",
  "owner-stale-status",
  "owner-replaced-attendee",
  "owner-replaced-listing",
  "owner-replaced-subscription",
  "owner-replaced-id",
  ...SubscriptionStatusSchema.options.map(
    (status) => `owner-observed-${status}`,
  ),
];
const checkoutScenarios = [
  "retry",
  "placeholder",
  "ledger-interrupted",
  "read-ended",
  "both-refused",
  "both-missing",
  "both-unavailable",
  "already-ended",
  "unreadable",
  "foreign",
  "blank-reference",
  "booked",
  "orphaned",
  "occupied",
  "anchorless",
  ...SubscriptionStatusSchema.options.map((status) => `failed-start-${status}`),
  ...SubscriptionStatusSchema.options.map((status) => `failed-end-${status}`),
];
const recordSets = recordSetsFor(CANCELLATION_TABLES);

const moduleFor = (facts: CancellationFacts): string =>
  tlaModule("SubscriptionCancellationData", [
    `Statuses == ${tlaSet(SubscriptionStatusSchema.options)}`,
    `ExpectedOwners == ${tlaSet(ownerScenarios)}`,
    `ExpectedCheckouts == ${tlaSet(checkoutScenarios)}`,
    ...recordSets(facts),
  ]);

/** Each control changes the real source boundary before its output is rendered. */
const boundaryControls = [
  ["refund before confirmed external end", "refund-before-confirmed-end"],
  ["local end without final returned money", "local-end-without-money"],
  ["ended status overwritten by a stale live write", "stale-overwrite"],
  ["cancellation sent to another subscription", "wrong-cancellation-identity"],
  [
    "owner fallback read sent to another subscription",
    "wrong-owner-subscription-read",
  ],
  [
    "owner invoice read sent to another subscription",
    "wrong-owner-invoice-read",
  ],
  [
    "failed checkout fallback read sent to another subscription",
    "wrong-checkout-subscription-read",
  ],
  ["anchorless retry lost its retained plan", "anchorless-plan-loss"],
  ["duplicate failed checkout refund on replay", "duplicate-refund"],
  ["false local refund completion", "false-local-completion"],
] as const satisfies readonly (readonly [string, CancellationFault])[];

const boundaryControl = ([name, fault]: readonly [
  string,
  CancellationFault,
]): ModelControl => ({
  data: async () => moduleFor(await cancellationFacts(fault)),
  name,
  phase: "step",
});

export const { controls, modelData } = producerFor(
  cancellationFacts,
  moduleFor,
  (facts) => facts,
  {
    fields: [],
    missing: [
      [
        "missing owner cancellation evidence",
        "initial",
        "owners",
        { scenario: "owner-final" },
      ],
    ],
  },
  () => boundaryControls.map(boundaryControl),
);
