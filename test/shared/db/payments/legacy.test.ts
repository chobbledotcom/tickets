import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import * as v from "valibot";
import { hmacHash } from "#shared/crypto/hashing.ts";
import {
  LegacyCheckoutStageSchema,
  type LegacyPaymentRows,
  LegacyPaymentRuntimeSchema,
  LegacyProcessedPaymentSchema,
  LegacySumupCheckoutSchema,
  legacySessionFields,
  mergeLegacyPaymentRows,
} from "#shared/db/payments/legacy.ts";
import { setupTestEncryptionKey } from "#test-utils/env.ts";

// Grouping old payment rows hashes the checkout reference, which needs a key.
// Setting one here keeps this file runnable on its own rather than depending on
// whichever other file in its isolate happened to set one up first.
setupTestEncryptionKey();

const TIME = "2026-07-25T10:00:00.000Z";
const TICKETS = "enc:1:iv:tickets";

const processed = (changes: Record<string, unknown> = {}) => {
  const attendeeId = changes.attendeeId ?? null;
  return v.parse(LegacyProcessedPaymentSchema, {
    attendeeId,
    failureData: "",
    listingId: attendeeId === null ? null : 7,
    paymentReference: "",
    paymentSessionId: "session-one",
    processedAt: TIME,
    providerRefundedAt: "",
    ticketTokens: "",
    ...changes,
  });
};

const stage = (changes: Record<string, unknown> = {}) =>
  v.parse(LegacyCheckoutStageSchema, {
    attendeeId: 42,
    createdAt: TIME,
    paymentSessionId: "session-one",
    provider: "sumup",
    state: "pending",
    ticketTokens: TICKETS,
    ...changes,
  });

const sumup = (changes: Record<string, unknown> = {}) =>
  v.parse(LegacySumupCheckoutSchema, {
    createdAt: TIME,
    metadata: "enc:1:iv:metadata",
    referenceIndex: "reference-index",
    sumupId: "session-one",
    wrappedKey: "wk:1:key",
    ...changes,
  });

const sourceRows = (
  rows: Omit<LegacyPaymentRows, "attendeePayments">,
): LegacyPaymentRows => ({ attendeePayments: [], ...rows });

const onlyGroup = async (rows: Omit<LegacyPaymentRows, "attendeePayments">) => {
  const groups = await mergeLegacyPaymentRows(sourceRows(rows));
  const group = groups[0];
  if (groups.length !== 1 || group === undefined) {
    throw new Error("Expected one legacy payment group");
  }
  return group;
};

const errorMessage = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    if (error instanceof v.ValiError) {
      const issue = error.issues[0];
      if (issue !== undefined) return issue.message;
    }
    if (error instanceof Error) return error.message;
    throw error;
  }
  throw new Error("Expected an error");
};

test("merges all source rows that identify the same payment", async () => {
  const groups = await mergeLegacyPaymentRows(
    sourceRows({
      checkoutStages: [stage()],
      processedPayments: [processed({ attendeeId: 42, ticketTokens: TICKETS })],
      sumupCheckouts: [sumup()],
    }),
  );
  expect(groups).toHaveLength(1);
  expect(groups[0]?.runtime).toEqual({
    attendeePayment: null,
    checkoutStage: stage(),
    processedPayment: processed({ attendeeId: 42, ticketTokens: TICKETS }),
    sumupCheckout: sumup(),
  });
  const group = groups[0];
  if (group === undefined) throw new Error("Expected the merged payment");
  expect(legacySessionFields(group)).toEqual({
    attendeeId: 42,
    completionState: "legacy_unknown",
    createdAt: Date.parse(TIME),
    provider: "sumup",
    result: null,
    resultState: "succeeded",
    state: "completed",
    ticketState: "ready",
    ticketTokens: TICKETS,
    updatedAt: Date.parse(TIME),
  });
});

test("maps every non-success legacy lifecycle without inventing a result", async () => {
  const groups = await mergeLegacyPaymentRows(
    sourceRows({
      checkoutStages: [
        stage({ paymentSessionId: "refunding", state: "refunding" }),
      ],
      processedPayments: [
        processed({ attendeeId: 42, paymentSessionId: "consumed" }),
        processed({
          failureData: "enc:1:iv:failure",
          paymentSessionId: "failed",
        }),
        processed({ paymentSessionId: "processing" }),
      ],
      sumupCheckouts: [sumup({ referenceIndex: "standalone", sumupId: "" })],
    }),
  );
  expect(
    groups.map((group) => {
      const fields = legacySessionFields(group);
      return [group.key, fields.state, fields.resultState, fields.result];
    }),
  ).toEqual([
    ["session:consumed", "completed", "succeeded", null],
    ["session:failed", "failed", "failed", "enc:1:iv:failure"],
    ["session:processing", "processing", "none", null],
    ["session:refunding", "refunding", "none", null],
    ["sumup:standalone", "pending", "none", null],
  ]);
  const consumed = groups[0];
  if (consumed === undefined) throw new Error("Expected the consumed payment");
  expect(legacySessionFields(consumed).ticketState).toBe("consumed");
});

test("rejects conflicting attendees before migration", async () => {
  const group = await onlyGroup({
    checkoutStages: [stage({ attendeeId: 42 })],
    processedPayments: [processed({ attendeeId: 43 })],
    sumupCheckouts: [],
  });
  expect(() => legacySessionFields(group)).toThrow("conflicting attendees");
});

test("rejects a SumUp row attached to another provider", async () => {
  const group = await onlyGroup({
    checkoutStages: [stage({ provider: "stripe" })],
    processedPayments: [],
    sumupCheckouts: [sumup()],
  });
  expect(() => legacySessionFields(group)).toThrow("conflicting providers");
});

test("rejects two SumUp rows claiming the same session", async () => {
  await expect(
    mergeLegacyPaymentRows(
      sourceRows({
        checkoutStages: [stage()],
        processedPayments: [],
        sumupCheckouts: [sumup(), sumup({ referenceIndex: "other-reference" })],
      }),
    ),
  ).rejects.toThrow("two sumupCheckout rows");
});

test("rejects unknown source facts", () => {
  expect(() => stage({ provider: "other" })).toThrow();
  expect(() => stage({ state: "other" })).toThrow();
  expect(() => stage({ ticketTokens: "plaintext" })).toThrow();
  expect(() => processed({ paymentReference: "plaintext" })).toThrow();
  expect(() => sumup({ metadata: "plaintext" })).toThrow();
});

test("names an invalid legacy time exactly", () => {
  expect(errorMessage(() => stage({ createdAt: "not-a-time" }))).toBe(
    "Legacy payment time must be a real instant",
  );
});

test("requires the exact owner ciphertext prefix", () => {
  expect(
    processed({ paymentReference: "hyb:1:key:iv:provider-reference" })
      .paymentReference,
  ).toBe("hyb:1:key:iv:provider-reference");
});

test("requires a non-empty wrapped SumUp key", () => {
  expect(() => sumup({ wrappedKey: "" })).toThrow();
});

test("requires a positive processed attendee id", () => {
  expect(processed({ attendeeId: 1 }).attendeeId).toBe(1);
  expect(() => processed({ attendeeId: 0 })).toThrow();
});

test("requires a positive staged attendee id", () => {
  expect(stage({ attendeeId: 1 }).attendeeId).toBe(1);
  expect(() => stage({ attendeeId: 0 })).toThrow();
});

test("names contradictory terminal results exactly", () => {
  expect(
    errorMessage(() =>
      processed({ attendeeId: 42, failureData: "enc:1:iv:failure" }),
    ),
  ).toBe("A legacy payment cannot be both completed and failed");
});

test("accepts a refund marker only with an encrypted reference", () => {
  expect(
    processed({
      paymentReference: "hyb:1:key:iv:provider-reference",
      providerRefundedAt: TIME,
    }).providerRefundedAt,
  ).toBe(TIME);
  expect(errorMessage(() => processed({ providerRefundedAt: TIME }))).toBe(
    "A legacy provider refund requires a payment reference",
  );
});

test("names an empty runtime exactly", () => {
  expect(
    errorMessage(() =>
      v.parse(LegacyPaymentRuntimeSchema, {
        attendeePayment: null,
        checkoutStage: null,
        processedPayment: null,
        sumupCheckout: null,
      }),
    ),
  ).toBe("Legacy payment runtime must contain a source row");
});

test("rejects duplicate processed rows", async () => {
  await expect(
    mergeLegacyPaymentRows(
      sourceRows({
        checkoutStages: [],
        processedPayments: [processed(), processed()],
        sumupCheckouts: [],
      }),
    ),
  ).rejects.toThrow("two processedPayment rows");
});

test("rejects duplicate checkout stages", async () => {
  await expect(
    mergeLegacyPaymentRows(
      sourceRows({
        checkoutStages: [stage(), stage()],
        processedPayments: [],
        sumupCheckouts: [],
      }),
    ),
  ).rejects.toThrow("two checkoutStage rows");
});

test("does not attach an unmatched SumUp id to a session", async () => {
  const group = await onlyGroup({
    checkoutStages: [],
    processedPayments: [],
    sumupCheckouts: [sumup({ sumupId: "unmatched" })],
  });
  expect(group.key).toBe("sumup:reference-index");
});

test("keeps processed tickets without a checkout stage", async () => {
  const group = await onlyGroup({
    checkoutStages: [],
    processedPayments: [processed({ attendeeId: 42, ticketTokens: TICKETS })],
    sumupCheckouts: [],
  });
  expect(legacySessionFields(group)).toMatchObject({
    completionState: "legacy_unknown",
    provider: null,
    ticketState: "ready",
    ticketTokens: TICKETS,
  });
});

test("uses SumUp only when SumUp is the known provider", async () => {
  const sumupOnly = await onlyGroup({
    checkoutStages: [],
    processedPayments: [],
    sumupCheckouts: [sumup({ sumupId: "" })],
  });
  const processedOnly = await onlyGroup({
    checkoutStages: [],
    processedPayments: [processed()],
    sumupCheckouts: [],
  });
  expect(legacySessionFields(sumupOnly).provider).toBe("sumup");
  expect(legacySessionFields(processedOnly).provider).toBeNull();
});

test("keeps a staged provider without SumUp recovery data", async () => {
  const group = await onlyGroup({
    checkoutStages: [stage({ provider: "stripe" })],
    processedPayments: [],
    sumupCheckouts: [],
  });
  expect(legacySessionFields(group).provider).toBe("stripe");
});

test("keeps failed completion explicitly empty", async () => {
  const group = await onlyGroup({
    checkoutStages: [],
    processedPayments: [processed({ failureData: "enc:1:iv:failure" })],
    sumupCheckouts: [],
  });
  expect(legacySessionFields(group).completionState).toBe("none");
});

test("folds a SumUp checkout filed under its own session onto one payment", async () => {
  // The checkout can be found two ways at once: by the reference kept on the
  // staged checkout, and by the session id SumUp gave it. Both point at the
  // same payment, so it stays one payment rather than becoming two.
  const group = await onlyGroup({
    checkoutStages: [stage({ paymentSessionId: "session-one" })],
    processedPayments: [],
    sumupCheckouts: [
      sumup({
        referenceIndex: await hmacHash("session-one"),
        sumupId: "session-one",
      }),
    ],
  });

  expect(group.key).toBe("session:session-one");
  expect(group.runtime.checkoutStage).not.toBeNull();
  expect(group.runtime.sumupCheckout).not.toBeNull();
});
