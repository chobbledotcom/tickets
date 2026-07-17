/* jscpd:ignore-start */
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { processPaymentSession } from "#routes/api/payment-processing/index.ts";
import {
  recoverOrRefundUnexpectedCreate,
  recoverOrRefundUnexpectedProcessing,
} from "#routes/api/payment-processing/recovery.ts";
import type { PaymentResult } from "#routes/api/webhook-types.ts";
import { beginCheckoutStageRefund } from "#shared/db/checkout-stages.ts";
import { getDb, queryAll } from "#shared/db/client.ts";
import { getListingsWithCountsByIds } from "#shared/db/listings/records.ts";
import { reserveSession } from "#shared/db/processed-payments.ts";
import { stripeApi } from "#shared/stripe.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { setupStripe } from "#test-utils/settings.ts";
import {
  attendeeIds,
  intentFor,
  paidSession,
  stageSession,
} from "./staged-runtime.helpers.ts";

/* jscpd:ignore-end */

const expectTerminalRefund = async (
  result: PaymentResult,
  refundCalls: number,
): Promise<void> => {
  expect(result).toMatchObject({ refundStatus: "refunded", success: false });
  expect(refundCalls).toBe(1);
  expect(await attendeeIds()).toEqual([]);
};

describeWithEnv(
  "payment processing > uncertain activation recovery",
  { db: true },
  () => {
    const recoveryFacts = async (sessionId: string) => {
      const listing = await createTestListing({ unitPrice: 1000 });
      const intent = intentFor(listing.id);
      const data = paidSession(sessionId, intent);
      const [loaded] = await getListingsWithCountsByIds([listing.id]);
      const validatedItems = [
        { expectedPrice: 1000, item: intent.items[0]!, listing: loaded! },
      ];
      return {
        data,
        intent,
        validatedItems,
      };
    };

    test("completes the exact attendee when primary state proves activation committed", async () => {
      const facts = await recoveryFacts("committed-recovery");
      await stageSession("committed-recovery", facts.intent);
      const processed = await processPaymentSession(
        "committed-recovery",
        facts.data,
      );
      if (!processed.success) throw new Error("Expected committed payment");
      let completedAttendeeId = 0;
      let completedTokens: string[] = [];

      const recovered = await recoverOrRefundUnexpectedCreate({
        complete: (entries, tokens) => {
          completedAttendeeId = entries[0]!.attendee.id;
          completedTokens = tokens;
          return Promise.resolve(processed);
        },
        error: new Error("lost activation result"),
        intent: facts.intent,
        session: facts.data.session,
        ticketToken: processed.ticketTokens[0]!,
        validatedItems: facts.validatedItems,
      });

      expect(recovered).toEqual(processed);
      expect(completedAttendeeId).toBe(processed.attendee.id);
      expect(completedTokens).toEqual([processed.ticketTokens[0]!]);
    });

    test("refunds when the unresolved reservation and stage prove rollback", async () => {
      await setupStripe();
      const facts = await recoveryFacts("rolled-back-recovery");
      await stageSession("rolled-back-recovery", facts.intent);
      expect((await reserveSession("rolled-back-recovery")).reserved).toBe(
        true,
      );
      const refund = stub(stripeApi, "refundPayment", () =>
        Promise.resolve({
          id: "rolled-back-refund",
          status: "succeeded",
        } as never),
      );
      try {
        const recovered = await recoverOrRefundUnexpectedCreate({
          complete: () => {
            throw new Error("Rollback must not complete a ticket");
          },
          error: new Error("lost rolled-back result"),
          intent: facts.intent,
          session: facts.data.session,
          ticketToken: "rolled-back-token",
          validatedItems: facts.validatedItems,
        });
        await expectTerminalRefund(recovered, refund.calls.length);
      } finally {
        refund.restore();
      }
    });

    test("rethrows when neither a reservation nor stage proves rollback", async () => {
      const facts = await recoveryFacts("ambiguous-recovery");
      await expect(
        recoverOrRefundUnexpectedCreate({
          complete: () => {
            throw new Error("Ambiguous state must not complete a ticket");
          },
          error: new Error("ambiguous activation"),
          intent: facts.intent,
          session: facts.data.session,
          ticketToken: "ambiguous-token",
          validatedItems: facts.validatedItems,
        }),
      ).rejects.toThrow("ambiguous activation");
    });

    test("rethrows an ordinary processing error when its stage is missing", async () => {
      const facts = await recoveryFacts("missing-processing-stage");
      await expect(
        recoverOrRefundUnexpectedProcessing(
          "missing-processing-stage",
          facts.data,
          new Error("processing failed"),
        ),
      ).rejects.toThrow("processing failed");
    });

    test("rethrows a balance processing error without looking for a stage", async () => {
      const facts = await recoveryFacts("balance-processing-error");
      const balanceData = {
        ...facts.data,
        intent: { ...facts.intent, balanceAttendeeId: 42 },
      };
      await expect(
        recoverOrRefundUnexpectedProcessing(
          "balance-processing-error",
          balanceData,
          new Error("balance failed"),
        ),
      ).rejects.toThrow("balance failed");
    });

    test("releases the reservation when an already-refunding stage errors", async () => {
      const facts = await recoveryFacts("refunding-processing-error");
      await stageSession("refunding-processing-error", facts.intent);
      expect(
        (await reserveSession("refunding-processing-error")).reserved,
      ).toBe(true);
      await beginCheckoutStageRefund("refunding-processing-error");
      await expect(
        recoverOrRefundUnexpectedProcessing(
          "refunding-processing-error",
          facts.data,
          new Error("refund continuation failed"),
        ),
      ).rejects.toThrow("refund continuation failed");
      expect(
        await queryAll(
          "SELECT payment_session_id FROM processed_payments WHERE payment_session_id = ?",
          ["refunding-processing-error"],
        ),
      ).toEqual([]);
    });

    test("refunds a pending stage after an unexpected processing error", async () => {
      await setupStripe();
      const facts = await recoveryFacts("unexpected-processing-refund");
      await stageSession("unexpected-processing-refund", facts.intent);
      expect(
        (await reserveSession("unexpected-processing-refund")).reserved,
      ).toBe(true);
      const refund = stub(stripeApi, "refundPayment", () =>
        Promise.resolve({
          id: "unexpected-processing-refund",
          status: "succeeded",
        } as never),
      );
      try {
        const result = await recoverOrRefundUnexpectedProcessing(
          "unexpected-processing-refund",
          facts.data,
          new Error("unexpected processing failure"),
        );
        await expectTerminalRefund(result, refund.calls.length);
      } finally {
        refund.restore();
      }
    });

    test("releases the reservation when unexpected refund finalization fails", async () => {
      await setupStripe();
      const facts = await recoveryFacts("unexpected-finalization-error");
      await stageSession("unexpected-finalization-error", facts.intent);
      expect(
        (await reserveSession("unexpected-finalization-error")).reserved,
      ).toBe(true);
      const refund = stub(stripeApi, "refundPayment", () =>
        Promise.resolve({
          id: "unexpected-finalization-error",
          status: "succeeded",
        } as never),
      );
      await getDb().execute(`CREATE TRIGGER reject_terminal_refund_write
        BEFORE UPDATE OF failure_data ON processed_payments
        WHEN NEW.payment_session_id = 'unexpected-finalization-error'
        BEGIN
          SELECT RAISE(ABORT, 'terminal refund write failed');
        END`);
      try {
        await expect(
          recoverOrRefundUnexpectedProcessing(
            "unexpected-finalization-error",
            facts.data,
            new Error("unexpected processing failure"),
          ),
        ).rejects.toThrow("terminal refund write failed");
        expect(
          await queryAll(
            "SELECT payment_session_id FROM processed_payments WHERE payment_session_id = ?",
            ["unexpected-finalization-error"],
          ),
        ).toEqual([]);
      } finally {
        await getDb().execute("DROP TRIGGER reject_terminal_refund_write");
        refund.restore();
      }
    });
  },
);
