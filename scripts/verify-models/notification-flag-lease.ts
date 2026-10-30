/** The notification flag lease checker data: one attendee's
 *  pending-notification flags leased between two racing recoveries. The
 *  claim captures each outstanding flag's colour and zeroes it. The restore
 *  returns the captured colour. A clear-on-accept removes the owed work.
 *  The negative controls keep the safety verdicts honest. */

/* jscpd:ignore-start -- imports */
import * as v from "valibot";
import {
  clearPendingFlagStatement,
  PENDING_NOTIFICATION,
  type PendingNotificationFlag,
  type PendingNotificationSide,
  restorePendingFlagStatement,
} from "#db/attendees/notification-flags.ts";
import {
  type ModelDataSource,
  modelDataFor,
  tlaModule,
  tlaRecords,
} from "#scripts/verify-models/data.ts";

/* jscpd:ignore-end */

/** The two racing recoveries. The claim transaction lets only one capture
 *  the outstanding flags. */
export const WORKERS = ["w1", "w2"] as const;

/** The two flag sides one attendee's row carries. */
export const SIDES = ["email", "webhooks"] as const;

/** The representative attendee the model leases: an admin-added line whose
 *  email badge is orange and whose webhooks badge is red. The claim
 *  captures these two colours, and the restore must return each side's own
 *  colour, never a fixed one. */
export const REPRESENTATIVE = {
  email: PENDING_NOTIFICATION.admin,
  webhooks: PENDING_NOTIFICATION.online,
};

/** One claim fact: the flags the claim read, which sides it captured, and
 *  which recovery claimed. */
export const ClaimFactSchema = v.object({
  beforeEmail: v.picklist([0, 1, 2] as const),
  beforeWebhooks: v.picklist([0, 1, 2] as const),
  claimsEmail: v.boolean(),
  claimsWebhooks: v.boolean(),
  worker: v.picklist(WORKERS),
});
export type ClaimFact = v.InferOutput<typeof ClaimFactSchema>;

/** One restore fact: the colours one restore returns for the two sides. */
export const RestoreFactSchema = v.object({
  emailValue: v.picklist([1, 2] as const),
  webhooksValue: v.picklist([1, 2] as const),
});
export type RestoreFact = v.InferOutput<typeof RestoreFactSchema>;

/** One clear fact: the side a clear-on-accept zeroes. */
export const ClearFactSchema = v.object({
  side: v.picklist(SIDES),
});
export type ClearFact = v.InferOutput<typeof ClearFactSchema>;

/** The checker field types for one claim fact. */
const claimFields = {
  beforeEmail: "Int",
  beforeWebhooks: "Int",
  claimsEmail: "Bool",
  claimsWebhooks: "Bool",
  worker: "Str",
} as const;

/** The checker field types for one restore fact. */
const restoreFields = {
  emailValue: "Int",
  webhooksValue: "Int",
} as const;

/** The checker field types for one clear fact. */
const clearFields = {
  side: "Str",
} as const;

/** Parse one fact list against its schema, so a changed fact shape fails in
 *  the generator before it reaches the checker. */
const parsedFacts = <Schema extends v.GenericSchema>(
  schema: Schema,
  facts: readonly v.InferOutput<Schema>[],
): v.InferOutput<Schema>[] => facts.map((fact) => v.parse(schema, fact));

/** The flag values the representative can hold on one side: zeroed, or its
 *  own colour. A claim reads one of these before it captures. */
const beforeValues = (
  side: PendingNotificationSide,
): readonly PendingNotificationFlag[] => [
  PENDING_NOTIFICATION.none,
  REPRESENTATIVE[side],
];

/** An outstanding flag colour, the only colour a restore can return. */
type RestoreColour = Exclude<PendingNotificationFlag, 0>;

/** The claim facts one recovery meets: every pair of before-values the
 *  representative can hold, for both recoveries. A side is captured exactly
 *  when its value is outstanding, the claim's own rule. */
export const claimFacts = (): ClaimFact[] => {
  const facts: ClaimFact[] = [];
  for (const worker of WORKERS) {
    for (const beforeEmail of beforeValues("email")) {
      for (const beforeWebhooks of beforeValues("webhooks")) {
        facts.push({
          beforeEmail,
          beforeWebhooks,
          claimsEmail: beforeEmail > PENDING_NOTIFICATION.none,
          claimsWebhooks: beforeWebhooks > PENDING_NOTIFICATION.none,
          worker,
        });
      }
    }
  }
  return parsedFacts(ClaimFactSchema, facts);
};

/** The colour the production restore statement writes back for one side.
 *  The claim captured it, and the restore returns it. */
const restoreValueFor = (side: PendingNotificationSide): RestoreColour =>
  restorePendingFlagStatement(side, [1], REPRESENTATIVE[side])
    .args[0] as RestoreColour;

/** The restore facts: one restore returns the representative's own captured
 *  colours for both sides. */
export const restoreFacts = (): RestoreFact[] =>
  parsedFacts(RestoreFactSchema, [
    {
      emailValue: restoreValueFor("email"),
      webhooksValue: restoreValueFor("webhooks"),
    },
  ]);

/** The clear facts: production builds a clear statement for each side. */
export const clearFacts = (): ClearFact[] =>
  parsedFacts(
    ClearFactSchema,
    SIDES.map((side) => {
      clearPendingFlagStatement(side, [1]);
      return { side };
    }),
  );

/** One claim fact changed so the claim zeroes an up email flag without
 *  capturing it. The checker must reject the data. The facts are injectable
 *  so a test can reach the missing-victim throw. */
export const corruptClaimWithoutCapture = (
  facts: readonly ClaimFact[] = claimFacts(),
): ClaimFact[] => {
  const victim = facts.find(
    (fact) =>
      fact.worker === "w1" &&
      fact.beforeEmail === REPRESENTATIVE.email &&
      fact.claimsEmail,
  );
  if (victim === undefined) {
    throw new Error("The claim-without-capture control matches no claim fact.");
  }
  return facts.map((fact) =>
    fact === victim ? { ...fact, claimsEmail: false } : fact,
  );
};

/** The restore data with one extra fact that invents a colour: the email
 *  side returns the online colour the claim never captured for it. */
export const corruptRestoreColour = (): RestoreFact[] => [
  ...restoreFacts(),
  {
    emailValue: PENDING_NOTIFICATION.online,
    webhooksValue: REPRESENTATIVE.webhooks,
  },
];

const moduleFor = (
  claims: readonly ClaimFact[],
  restores: readonly RestoreFact[],
  clears: readonly ClearFact[],
): string =>
  tlaModule("NotificationFlagLeaseData", [
    tlaRecords("ClaimFacts", claimFields, claims),
    tlaRecords("RestoreFacts", restoreFields, restores),
    tlaRecords("ClearFacts", clearFields, clears),
  ]);

/** The generated checker data. Every fact comes from the production flag
 *  functions; no stored move table supplies the proof. */
export const notificationFlagLeaseModelData: ModelDataSource = modelDataFor(
  () => moduleFor(claimFacts(), restoreFacts(), clearFacts()),
);

/** The claim data with one claim that zeroes without capturing, which the
 *  checker must reject. */
export const corruptClaimWithoutCaptureData: ModelDataSource = modelDataFor(
  () => moduleFor(corruptClaimWithoutCapture(), restoreFacts(), clearFacts()),
);

/** The restore data with one invented colour, which the checker must
 *  reject. */
export const corruptRestoreColourData: ModelDataSource = modelDataFor(() =>
  moduleFor(claimFacts(), corruptRestoreColour(), clearFacts()),
);
