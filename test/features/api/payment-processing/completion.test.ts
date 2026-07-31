import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { completeStoredPayment } from "#routes/api/payment-processing/completion.ts";
import { completionAttendeeId } from "#routes/api/payment-processing/completion-runtime.ts";
import type { PaymentWork } from "#routes/api/webhook-types.ts";
import type { PaymentSessionClaim } from "#shared/db/payments/claims.ts";
import { storedStripePayment } from "#test-utils/stripe/provider-fixtures.ts";

/** Both refusals below read only the payment, so the rest of the work stays
 *  an empty shell rather than a database round trip that proves nothing. */
const claim = {} as PaymentSessionClaim;

describe("picking up a stored payment where it left off", () => {
  test("refuses a payment that never wrote down what it was going to do", () => {
    // Finishing a payment means carrying out the plan saved when the money
    // was taken. With no plan there is nothing to carry out, and guessing
    // could book the wrong thing.
    const work = { payment: storedStripePayment() } as PaymentWork;

    expect(() => completeStoredPayment(work)).toThrow("has no completion plan");
  });

  test("refuses to carry on when the booking it belongs to is missing", () => {
    expect(() =>
      completionAttendeeId({ claim, payment: storedStripePayment() }),
    ).toThrow("has no completion attendee");
  });
});
