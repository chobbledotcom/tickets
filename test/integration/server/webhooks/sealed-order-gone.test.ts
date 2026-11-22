/** A paid card checkout whose sealed order is gone, or will not open. The
 * webhook and the buyer's return page answer from where the session stands.
 * Only a session that is not settled raises the lost-order alarm, and the
 * site never refunds it. The cancel page still answers.
 *
 * The shop is driven through its pages and the fake Stripe. Only the loss of
 * a stored row needs the database, because no visitor can delete one. */

import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { execute } from "#db/client.ts";
import { sql } from "#db/sql.ts";
import {
  type CardShop,
  checkOut,
  deliverPayment,
  openCardShop,
  returnPage,
  rosterOf,
} from "#test/blackbox/card-shop.ts";
import { createApp, inProcess } from "#test/blackbox/driver.ts";
import { describeWithEnv } from "#test-utils/db.ts";

const LOST_NOTE = "No booking was made, because the order details are missing.";
const LOST_LINE = "could not be booked, because the order details are missing.";

describeWithEnv(
  "a sealed card checkout whose order is gone",
  { db: true },
  () => {
    let shop: CardShop | undefined;
    const open = async () => {
      shop = await openCardShop();
      return shop;
    };
    afterEach(async () => {
      await shop?.fake.close();
      shop = undefined;
    });

    const loseOrders = () => execute(sql`DELETE FROM checkout_bundles`);

    const listingPage = async (opened: CardShop) =>
      (await opened.owner.get(`/admin/listing/${opened.listing.id}`)).html;

    const timesIn = (html: string, text: string): number =>
      html.split(text).length - 1;

    test("a paid session that is not settled raises one alarm, refuses retryably, and refunds nothing", async () => {
      const opened = await open();
      const checkout = await checkOut(opened);
      await loseOrders();

      expect((await deliverPayment(opened, checkout)).status).toBe(503);
      expect((await deliverPayment(opened, checkout)).status).toBe(503);

      expect(await rosterOf(opened)).toEqual([]);
      expect(opened.fake.refundCount()).toBe(0);
      expect(timesIn(await listingPage(opened), LOST_NOTE)).toBe(1);
      expect(
        timesIn((await opened.owner.get("/admin/log")).html, LOST_LINE),
      ).toBe(1);
    });

    test("an order that will not open raises the alarm too", async () => {
      const opened = await open();
      const checkout = await checkOut(opened);
      await execute(sql`UPDATE checkout_bundles SET sealed = ${"enc:1:AAAA"}`);

      expect((await deliverPayment(opened, checkout)).status).toBe(503);

      expect(await listingPage(opened)).toContain(
        "No booking was made, because the order details could not be read.",
      );
    });

    test("the return page of a paid session that is not settled refuses retryably and raises the alarm", async () => {
      const opened = await open();
      const checkout = await checkOut(opened);
      await loseOrders();
      await opened.fake.completedEvent(checkout);

      expect((await returnPage(checkout)).status).toBe(503);
      expect(timesIn(await listingPage(opened), LOST_NOTE)).toBe(1);
    });

    test("a booked session answers a later callback as settled, with no alarm", async () => {
      const opened = await open();
      const checkout = await checkOut(opened);
      await deliverPayment(opened, checkout);
      await loseOrders();

      const replay = await deliverPayment(opened, checkout);

      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual({
        error: "This payment has already been processed.",
        processed: false,
        received: true,
      });
      expect(await rosterOf(opened)).toEqual([["Sealed Buyer", 2]]);
      expect(await listingPage(opened)).not.toContain(LOST_NOTE);
    });

    test("a booked session shows the success page", async () => {
      const opened = await open();
      const checkout = await checkOut(opened);
      await deliverPayment(opened, checkout);
      await loseOrders();

      const page = await returnPage(checkout);

      expect(page.status).toBe(200);
      expect(page.html).toContain('data-payment-result="success"');
    });

    test("a refunded session shows its refund message, not success", async () => {
      const opened = await open();
      const checkout = await checkOut(opened);
      await deliverPayment(opened, checkout, { charged: 1999 });
      await loseOrders();

      const page = await returnPage(checkout);

      expect(page.html).not.toContain('data-payment-result="success"');
      expect(page.html).toContain(
        "Your payment has been automatically refunded.",
      );
    });

    test("a session found only in the ledger says it was already handled", async () => {
      const opened = await open();
      const checkout = await checkOut(opened);
      await deliverPayment(opened, checkout);
      await loseOrders();
      await execute(sql`DELETE FROM processed_payments`);

      const page = await returnPage(checkout);

      expect(page.status).toBe(200);
      expect(page.html).toContain("This payment was already handled.");
      expect(await listingPage(opened)).not.toContain(LOST_NOTE);
    });

    test("the cancel page still answers, with no retry link", async () => {
      const opened = await open();
      const checkout = await checkOut(opened);
      await loseOrders();

      const page = await createApp(inProcess).get(
        `/payment/cancel?session_id=${checkout.id}`,
      );

      expect(page.status).toBe(200);
      expect(page.html).toContain('data-payment-result="cancel"');
      expect(page.html).not.toContain(`/ticket/${opened.listing.slug}`);
    });
  },
);
