/** A paid card checkout whose sealed order is gone, or will not open. The
 * webhook and the buyer's return page answer from where the session stands.
 * Only a session that is not settled is reported to the admin, and the site
 * never refunds it. The cancel page still answers.
 *
 * The shop is driven through its pages and the fake Stripe. Only the loss of
 * a stored row needs the database, because no visitor can delete one. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { sql } from "#db/sql.ts";
import { t } from "#i18n";
import type { PaymentRowState } from "#payment/row-state.ts";
import {
  type CardShop,
  cancelPage,
  checkOut,
  checkOutBalance,
  deliverPayment,
  returnPage,
  rosterOf,
  useCardShop,
} from "#test/blackbox/card-shop.ts";
import type { FakeCheckout } from "#test/blackbox/fake-stripe.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  CLAIM_MIRROR,
  putRowState,
  REVIEW_MIRROR,
  refundClaimFixture,
  reviewCase,
  rowStateSlot,
  UNRECORDED_MIRROR,
} from "#test-utils/payment-claim.ts";
import { runWrite } from "#test-utils/raw-db.ts";

type LostReason = "bundle_missing" | "bundle_unreadable";

/** What the admin reads about a lost 20.00 order: the note on the listing,
 * the activity line, and the start of the error log entry. */
const reportOf = (checkout: FakeCheckout, why: LostReason) => {
  const facts = {
    amount: "£20",
    provider: "Stripe",
    reason: t(`payment.lost_order.${why}`),
    reference: checkout.paymentIntent,
  };
  return {
    activity: t("payment.lost_order.activity", facts),
    error: `Paid checkout has no usable sealed order: ${why} (session=${checkout.id}`,
    note: t("payment.lost_order.note", facts),
  };
};

const NOT_REPORTED = { activity: 0, error: 0, note: 0 };

/** Refund work that an owner's refund can leave on a booked payment row: the
 * stored record, and the plain word that mirrors it. */
const BOOKED_ROWS: [string, PaymentRowState | null, string][] = [
  ["holds no refund work", null, ""],
  [
    "holds an owner review",
    { review: reviewCase({ kind: "partially_returned_obligation" }) },
    REVIEW_MIRROR,
  ],
  [
    "holds money not yet in the books",
    { unrecorded: { returnedAt: "2026-01-01T00:00:00.000Z" } },
    UNRECORDED_MIRROR,
  ],
  [
    "holds a refund claim",
    { claim: refundClaimFixture(1, "checking", "2026-01-01T00:00:00.000Z") },
    CLAIM_MIRROR,
  ],
];

/** The two kinds of paid checkout whose money the ledger records under its
 * own group: a booking, and the balance of an earlier booking. */
const LEDGER_PAYMENTS: [string, (shop: CardShop) => Promise<FakeCheckout>][] = [
  ["a booking", checkOut],
  ["a balance payment", checkOutBalance],
];

const timesIn = (html: string, text: string): number =>
  html.split(text).length - 1;

describeWithEnv(
  "a sealed card checkout whose order is gone",
  { db: true },
  () => {
    const { checkedOut, open } = useCardShop();

    const loseOrders = () => runWrite(sql`DELETE FROM checkout_bundles`);

    /** How often the admin's pages show each part of a report: the listing
     * page holds the note, and the log page holds the other two. */
    const shown = async (
      opened: CardShop,
      report: ReturnType<typeof reportOf>,
    ) => {
      const listing = await opened.owner.get(
        `/admin/listing/${opened.listing.id}`,
      );
      const log = await opened.owner.get("/admin/log");
      return {
        activity: timesIn(log.html, report.activity),
        error: timesIn(log.html, report.error),
        note: timesIn(listing.html, report.note),
      };
    };

    /** How often the admin's log page shows a line. */
    const logged = async (opened: CardShop, line: string) =>
      timesIn((await opened.owner.get("/admin/log")).html, line);

    test("a paid session that is not settled is reported once, refused for a retry, and never refunded", async () => {
      const { checkout, opened } = await checkedOut();
      const report = reportOf(checkout, "bundle_missing");
      expect(await shown(opened, report)).toEqual(NOT_REPORTED);
      await loseOrders();

      expect((await deliverPayment(opened, checkout)).status).toBe(503);
      expect((await deliverPayment(opened, checkout)).status).toBe(503);
      const page = await returnPage(checkout);

      expect(page.status).toBe(503);
      expect(page.html).toContain(t("payment.error.verification_failed"));
      expect(await shown(opened, report)).toEqual({
        activity: 1,
        error: 3,
        note: 1,
      });
      expect(await rosterOf(opened)).toEqual([]);
      expect(opened.fake.refunds).toEqual([]);
    });

    test("an order that will not open is reported with its own reason, and never refunded", async () => {
      const { checkout, opened } = await checkedOut();
      await runWrite(sql`UPDATE checkout_bundles SET sealed = ${"enc:1:AAAA"}`);

      expect((await deliverPayment(opened, checkout)).status).toBe(503);

      expect(
        await shown(opened, reportOf(checkout, "bundle_unreadable")),
      ).toEqual({ activity: 1, error: 1, note: 1 });
      expect(await rosterOf(opened)).toEqual([]);
      expect(opened.fake.refunds).toEqual([]);
    });

    test("a receipt whose payment row was pruned books nobody, even after the listing reopens", async () => {
      const opened = await open();
      const checkout = await checkOut(opened);
      const turnListing = (route: "deactivate" | "reactivate") =>
        opened.api.post(
          `/api/admin/listings/${opened.listing.id}/${route}`,
          {},
        );
      await turnListing("deactivate");
      await deliverPayment(opened, checkout);
      await runWrite(sql`DELETE FROM processed_payments`);
      await turnListing("reactivate");

      const replay = await deliverPayment(opened, checkout);

      expect(replay.status).toBe(503);
      expect(await rosterOf(opened)).toEqual([]);
    });

    test("the return page alone reports a paid session that is not settled", async () => {
      const { checkout, opened } = await checkedOut();
      await loseOrders();
      opened.fake.pay(checkout);

      const page = await returnPage(checkout);

      expect(page.status).toBe(503);
      expect(page.html).toContain(t("payment.error.verification_failed"));
      expect(await shown(opened, reportOf(checkout, "bundle_missing"))).toEqual(
        { activity: 1, error: 1, note: 1 },
      );
      expect(await rosterOf(opened)).toEqual([]);
      expect(opened.fake.refunds).toEqual([]);
    });

    for (const [name, work, mirror] of BOOKED_ROWS) {
      test(`a booked session whose payment row ${name} answers as settled, with no report`, async () => {
        const { checkout, opened } = await checkedOut();
        await deliverPayment(opened, checkout);
        if (work !== null) {
          await putRowState(checkout.id, await rowStateSlot(work), mirror);
        }
        await loseOrders();

        const page = await returnPage(checkout);
        const replay = await deliverPayment(opened, checkout);

        expect(page.status).toBe(200);
        expect(page.html).toContain('data-payment-result="success"');
        expect(page.html).not.toContain('http-equiv="refresh"');
        expect(replay.status).toBe(200);
        expect(await replay.json()).toEqual({
          error: "This payment has already been processed.",
          processed: false,
          received: true,
        });
        expect(await rosterOf(opened)).toEqual([["Sealed Buyer", 2]]);
        expect(
          await logged(
            opened,
            "Session already booked, and its sealed order was pruned",
          ),
        ).toBe(1);
        expect(
          await shown(opened, reportOf(checkout, "bundle_missing")),
        ).toEqual(NOT_REPORTED);
      });
    }

    test("a refunded session shows its refund message, not success, and is not refunded again", async () => {
      const { checkout, opened } = await checkedOut();
      await deliverPayment(opened, checkout, { charged: 1999 });
      await loseOrders();

      const page = await returnPage(checkout);
      const replay = await deliverPayment(opened, checkout, { charged: 1999 });

      expect(page.status).toBe(200);
      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual({
        error: "This payment has already been processed.",
        processed: false,
        received: true,
      });
      expect(page.html).not.toContain('data-payment-result="success"');
      expect(page.html).toContain(t("payment.failure.refunded"));
      expect(opened.fake.refunds).toEqual([
        { amount: 1999, paymentIntent: checkout.paymentIntent },
      ]);
      expect(
        await logged(
          opened,
          "Session already ended with a final outcome, and its sealed order was pruned",
        ),
      ).toBe(1);
      expect(await shown(opened, reportOf(checkout, "bundle_missing"))).toEqual(
        NOT_REPORTED,
      );
    });

    for (const [name, pay] of LEDGER_PAYMENTS) {
      test(`${name} found only in the ledger says it was already handled`, async () => {
        const opened = await open();
        const checkout = await pay(opened);
        await deliverPayment(opened, checkout);
        await loseOrders();
        await runWrite(sql`DELETE FROM processed_payments`);

        const page = await returnPage(checkout);
        const replay = await deliverPayment(opened, checkout);

        expect(page.status).toBe(200);
        expect(page.html).toContain(t("payment.error.already_handled"));
        expect(replay.status).toBe(200);
        expect(
          await logged(
            opened,
            "Session already recorded in the ledger, and its sealed order was pruned",
          ),
        ).toBe(1);
        expect(
          await shown(opened, reportOf(checkout, "bundle_missing")),
        ).toEqual(NOT_REPORTED);
        expect(opened.fake.refunds).toEqual([]);
      });
    }

    test("the cancel page still answers, with no link back to the booking page", async () => {
      const { checkout, opened } = await checkedOut();
      const retryLink = `href="/ticket/${opened.listing.slug}"`;
      expect((await cancelPage(checkout)).html).toContain(retryLink);
      await loseOrders();

      const page = await cancelPage(checkout);

      expect(page.status).toBe(200);
      expect(page.html).toContain('data-payment-result="cancel"');
      expect(page.html).not.toContain(retryLink);
    });
  },
);
