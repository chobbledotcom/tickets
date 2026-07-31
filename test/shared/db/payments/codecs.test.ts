import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { PAYMENT_STORAGE_CONTEXT } from "#shared/db/payments/codecs.ts";

test("keeps every payment storage context exact", () => {
  expect(PAYMENT_STORAGE_CONTEXT.bookingIntent).toBe(
    "payment_sessions.booking_intent",
  );
  expect(PAYMENT_STORAGE_CONTEXT.caseEvidence).toBe("payment_cases.evidence");
  expect(PAYMENT_STORAGE_CONTEXT.caseResource).toBe("payment_cases.resource");
  expect(PAYMENT_STORAGE_CONTEXT.caseResourceResolution).toBe(
    "payment_cases.resource resolution",
  );
  expect(PAYMENT_STORAGE_CONTEXT.chargeLookup).toBe(
    "payment_charges.provider_reference lookup",
  );
  expect(PAYMENT_STORAGE_CONTEXT.chargeReference).toBe(
    "payment_charges.provider_reference",
  );
  expect(PAYMENT_STORAGE_CONTEXT.pendingRefund).toBe(
    "payment_charges.pending_refund_id",
  );
  expect(PAYMENT_STORAGE_CONTEXT.sessionCompletion).toBe(
    "payment_sessions.completion",
  );
  expect(PAYMENT_STORAGE_CONTEXT.sessionResource).toBe(
    "payment_sessions.session_resource",
  );
  expect(PAYMENT_STORAGE_CONTEXT.sessionResult).toBe("payment_sessions.result");
  expect(PAYMENT_STORAGE_CONTEXT.sessionTicketTokens).toBe(
    "payment_sessions.ticket_tokens",
  );
});
