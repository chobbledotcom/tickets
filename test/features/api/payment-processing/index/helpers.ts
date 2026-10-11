import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { getAttendeesRaw } from "#db/attendees/queries.ts";
import { stageCheckoutAnswers } from "#db/checkout-pending-answers.ts";
import { execute } from "#db/client.ts";
import { getListingWithCount } from "#db/listings/records.ts";
import { listingQuestions } from "#db/questions/queries.ts";
import { getOrCreateStringIds } from "#db/questions/strings.ts";
import { answersTable, questionsTable } from "#db/questions/tables.ts";
import type { CreatedEntry } from "#routes/api/payment-processing/create.ts";
import { processPaymentSession } from "#routes/api/payment-processing/index.ts";
import type {
  PaymentResult,
  ValidatedSession,
} from "#routes/api/webhook-types.ts";
import type { BookingIntent, BookingItem } from "#shared/booking-intent.ts";
import type { ValidatedPaymentSession } from "#shared/payments.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { createFreeTextQuestion } from "#test-utils/db-helpers/questions.ts";
import { webhookMeta } from "#test-utils/factories.ts";
import { expectSessionFailed } from "#test-utils/processed-payments.ts";
import type { PaymentProviderType } from "#types";

export const bookingIntent = (
  items: BookingItem[],
  overrides: Partial<Omit<BookingIntent, "items">> = {},
): BookingIntent => ({
  address: "",
  date: null,
  email: "buyer@example.com",
  items,
  modifiers: [],
  name: "Buyer",
  phone: "",
  special_instructions: "",
  ...overrides,
});

export const paymentSession = (
  id: string,
  amountTotal: number,
  intent: BookingIntent,
  provider: PaymentProviderType = "stripe",
): ValidatedPaymentSession => ({
  amountTotal,
  createdAt: "2026-07-01T12:00:00.000Z",
  currency: "GBP",
  id,
  metadata: webhookMeta({
    email: intent.email,
    items: JSON.stringify(intent.items),
    name: intent.name,
  }),
  paymentReference: `pi_${id}`,
  paymentStatus: "paid",
  provider,
});

export const trustedPayment = (
  id: string,
  intent: BookingIntent,
  amountTotal: number,
  provider: PaymentProviderType = "stripe",
): ValidatedSession => ({
  intent,
  session: paymentSession(id, amountTotal, intent, provider),
  verdict: { agreed: amountTotal, verdict: "trusted" },
});

export const singleListingPayment = async (
  id: string,
  unitPrice: number,
  paidPrice = unitPrice,
): Promise<{
  data: ValidatedSession;
  listing: Awaited<ReturnType<typeof createTestListing>>;
}> => {
  const listing = await createTestListing({ maxAttendees: 5, unitPrice });
  return {
    data: trustedPayment(
      id,
      bookingIntent([{ e: listing.id, p: paidPrice, q: 1 }]),
      paidPrice,
    ),
    listing,
  };
};

export const ledgeredPaymentWithoutReservation = async (
  id: string,
  unitPrice: number,
): Promise<
  Awaited<ReturnType<typeof singleListingPayment>> & {
    attendeeId: number;
  }
> => {
  const payment = await singleListingPayment(id, unitPrice);
  const first = await processPaymentSession(id, payment.data);
  assert(first.success, "Expected first payment to succeed");
  await execute("DELETE FROM processed_payments WHERE payment_session_id = ?", [
    id,
  ]);
  return { ...payment, attendeeId: first.attendee.id };
};

export const expectStoredRefund = async (
  result: PaymentResult,
  expected: { detail: string; listingId: number; sessionId: string },
  refund: { calls: unknown[] },
): Promise<void> => {
  expect(result.success).toBe(false);
  assert(!result.success, "Expected a stored refund");
  expect(result.detail).toBe(expected.detail);
  expect(result.refunded).toBe(true);
  expect((await getAttendeesRaw(expected.listingId))[0]?.quantity).toBe(0);
  expect(refund.calls).toHaveLength(1);
  await expectSessionFailed(expected.sessionId);
};

/** One choice question with one active answer, asked on the listing the
 * caller names. Returns the answer the caller wires into its checkout or
 * submission. */
export const createChoiceAnswer = async (listingId: number) => {
  const question = await questionsTable.insert({
    displayType: "select",
    text: "Meal?",
  });
  const answer = await answersTable.insert({
    questionId: question.id,
    sortOrder: 0,
    text: "Soup",
  });
  await listingQuestions.setIds(listingId, [question.id]);
  return answer;
};

/** A paid checkout whose buyer answered the booked listing's choice question
 * (`withChoiceAnswer`), typed one free-text answer, or both. The free text
 * waits in the staged row the completion takes back. Pass `staged: false`
 * for a checkout whose row is already gone. */
export const checkoutWithTypedAnswer = async (
  id: string,
  {
    staged = true,
    withChoiceAnswer = false,
  }: { staged?: boolean; withChoiceAnswer?: boolean } = {},
): Promise<{
  answer: Awaited<ReturnType<typeof answersTable.insert>> | null;
  data: ValidatedSession;
  freeText: number;
  listing: Awaited<ReturnType<typeof createTestListing>>;
}> => {
  const { data, listing } = await singleListingPayment(id, 1000);
  const answer = withChoiceAnswer ? await createChoiceAnswer(listing.id) : null;
  if (withChoiceAnswer) {
    data.intent.listingAnswerIds = { [String(listing.id)]: [answer!.id] };
  }
  const freeText = await createFreeTextQuestion([listing.id]);
  const stringId = (await getOrCreateStringIds(["Arriving late"])).get(
    "Arriving late",
  )!;
  data.intent.listingTextAnswerIds = {
    [String(listing.id)]: [{ q: freeText, s: stringId }],
  };
  if (staged) {
    await stageCheckoutAnswers(
      id,
      { [String(freeText)]: "Arriving late" },
      null,
    );
  }
  return { answer, data, freeText, listing };
};

/** One booked line, as the code that writes the booking hands it on. */
export const bookedLine = async (
  name: string,
): Promise<{ attendeeId: number; entry: CreatedEntry; listingId: number }> => {
  const listing = await createTestListing({
    maxAttendees: 50,
    name,
    unitPrice: 1000,
  });
  const attendee = await createTestAttendee(
    listing.id,
    listing.slug,
    "Booked",
    `${listing.slug}@example.com`,
  );
  const loaded = await getListingWithCount(listing.id);
  return {
    attendeeId: attendee.id,
    entry: { attendee, listing: loaded! } as CreatedEntry,
    listingId: listing.id,
  };
};
