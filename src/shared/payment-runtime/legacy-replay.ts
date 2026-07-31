import * as v from "valibot";
import type { PaymentResult } from "#routes/api/webhook-types.ts";
import { decrypt } from "#shared/crypto/encryption.ts";
import type { LegacyPaymentReplay } from "#shared/db/payments/legacy-sessions.ts";
import { defineStoredJson } from "#shared/validation/stored-json.ts";

const LegacyFailureSchema = v.strictObject({
  error: v.string(),
  refunded: v.optional(v.boolean()),
  status: v.optional(v.pipe(v.number(), v.safeInteger())),
});
const legacyFailureJson = defineStoredJson(LegacyFailureSchema);

export const isTerminalLegacyPayment = (
  payment: LegacyPaymentReplay,
): boolean => {
  const processed = payment.runtime.processedPayment;
  return (
    processed !== null &&
    (processed.attendeeId !== null ||
      processed.failureData !== "" ||
      processed.providerRefundedAt !== "")
  );
};

const legacyTicketTokens = async (
  payment: LegacyPaymentReplay,
): Promise<string[]> => {
  const stored =
    payment.runtime.processedPayment?.ticketTokens ||
    payment.runtime.checkoutStage?.ticketTokens ||
    "";
  if (stored === "") return [];
  const plaintext = await decrypt(stored);
  return plaintext === "" ? [] : plaintext.split("+");
};

export const legacyPaymentResult = async (
  payment: LegacyPaymentReplay,
): Promise<PaymentResult> => {
  const processed = payment.runtime.processedPayment;
  if (processed === null) {
    throw new Error(`Legacy payment ${payment.id} has no terminal result`);
  }
  if (processed.attendeeId !== null) {
    return {
      attendee: { id: processed.attendeeId },
      listingId: processed.listingId!,
      success: true,
      ticketTokens: await legacyTicketTokens(payment),
    };
  }
  if (processed.failureData !== "") {
    const failure = legacyFailureJson.read(
      await decrypt(processed.failureData),
      `legacy payment failure for ${payment.id}`,
    );
    return {
      error: failure.error,
      ...(failure.status === undefined ? {} : { status: failure.status }),
      success: false,
    };
  }
  if (processed.providerRefundedAt !== "") {
    return {
      error: "This payment has been refunded.",
      status: 200,
      success: false,
    };
  }
  throw new Error(`Legacy payment ${payment.id} is not terminal`);
};
