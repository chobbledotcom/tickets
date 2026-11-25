/** The Subscriptions page: who subscribed, to what, and its Stripe status. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { executeBatch } from "#db/client.ts";
import { sql } from "#db/sql.ts";
import { postAttendeePayment } from "#test/integration/server/ledger/helpers.ts";
import { expectIncludesAll } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  bookingIdOf,
  bookOwnListing,
  MONTHLY,
  subscribe,
} from "#test-utils/db-helpers/subscriptions.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";
import {
  adminGet,
  createTestManagerSession,
  editorGetStatus,
} from "#test-utils/session.ts";
import {
  featureSetting,
  setupStripe,
  stubWebhookVerify,
  withSetting,
} from "#test-utils/settings.ts";
import { stripePaidInvoice } from "#test-utils/stripe/fixtures.ts";
import { withStripeRenewals } from "#test-utils/stripe/subscription-checkout.ts";
import { postWebhookAndAssert } from "#test-utils/webhooks.ts";

const pageHtml = async (path: string, cookie?: string): Promise<string> => {
  const response =
    cookie === undefined
      ? await adminGet(path)
      : await awaitTestRequest(path, { cookie });
  expect(response.status).toBe(200);
  return await response.text();
};

/** The rows of the page's table, in the order the page shows them. */
const tableRows = (html: string): string[] =>
  [...html.matchAll(/<tr>[\s\S]*?<\/tr>/g)].map(([row]) => row).slice(1);

/** Stripe reports one paid renewal of `subscriptionId`, on 1 March 2026. */
const renew = async (subscriptionId: string): Promise<void> => {
  await setupStripe();
  await withStripeRenewals(
    "active",
    [stripePaidInvoice({ id: `in_${subscriptionId}` })],
    async () => {
      const verify = await stubWebhookVerify({
        data: {
          object: {
            parent: {
              subscription_details: { subscription: subscriptionId },
              type: "subscription_details",
            },
          },
        },
        id: `evt_${subscriptionId}`,
        type: "invoice.paid",
      });
      await postWebhookAndAssert(() => verify.restore(), 200);
    },
  );
};

/** A refund of 5.00 from `attendeeId` back to the world, as a refund posts
 * its cash leg. */
const refundFive = (attendeeId: number) =>
  executeBatch([
    sql`INSERT INTO transfers (source_type, source_id, dest_type, dest_id, amount, occurred_at, recorded_at, reference, event_group, kind)
        VALUES ('attendee', ${String(attendeeId)}, 'external', 'world', 500, 1782120600000, 1782120600000, ${`refund-${attendeeId}`}, ${`refund-${attendeeId}`}, 'refund_cash')`,
  ]);

describeWithEnv("server (admin subscriptions)", { db: true }, () => {
  test("says nobody has subscribed yet", async () => {
    expectIncludesAll(await pageHtml("/admin/subscriptions"), [
      "<title>Subscriptions",
      "Nobody has bought a subscription ticket yet.",
    ]);
  });

  test("lists each subscriber with the plan and status Stripe reported, newest first", async () => {
    const { attendeeId: ada } = await subscribe("Ada", MONTHLY);
    const { attendeeId: bob } = await subscribe("Bob", {
      interval: "year",
      price: 12000,
      status: "past_due",
      tax: 0,
    });
    const [first, second] = tableRows(await pageHtml("/admin/subscriptions"));
    expectIncludesAll(first!, [
      `href="/admin/attendees/${bob}"`,
      ">Bob</a>",
      "Bob Club",
      "£120 every year",
      "<td>£0</td>",
      "Payment overdue",
      "sub_bob",
    ]);
    expectIncludesAll(second!, [
      `href="/admin/attendees/${ada}"`,
      ">Ada</a>",
      "Ada Club",
      "£6 every month",
      "<td>£1</td>",
      "Paid until the first charge",
      "sub_ada",
    ]);
  });

  test("shows a failed checkout after its ticket was removed", async () => {
    const { attendeeId, listingId } = await subscribe("Ada", MONTHLY);
    await executeBatch([
      sql`UPDATE listing_attendees SET quantity = 0 WHERE attendee_id = ${attendeeId}`,
      sql`DELETE FROM listings WHERE id = ${listingId}`,
    ]);
    expectIncludesAll(await pageHtml("/admin/subscriptions"), [
      `href="/admin/attendees/${attendeeId}"`,
      "Ticket removed",
      "£6 every month",
      "sub_ada",
    ]);
  });

  test("leaves out bookings that never subscribed", async () => {
    await bookOwnListing("Cy");
    expect(tableRows(await pageHtml("/admin/subscriptions"))).toEqual([]);
  });

  test("a manager can open the page", async () => {
    await subscribe("Ada", MONTHLY);
    const cookie = await createTestManagerSession();
    expect(await pageHtml("/admin/subscriptions", cookie)).toContain(
      ">Ada</a>",
    );
  });

  test("shows the owner a cancel button only for a subscription that still charges", async () => {
    const ada = await subscribe("Ada", MONTHLY);
    await subscribe("Bob", { ...MONTHLY, status: "canceled" });
    const html = await pageHtml("/admin/subscriptions");
    const [bob, adaRow] = tableRows(html);
    const adaBooking = await bookingIdOf(ada);
    expectIncludesAll(html, [
      "Warning: cancelling stops every later payment at once.",
      "<th>Cancel</th>",
    ]);
    expectIncludesAll(adaRow!, [
      `action="/admin/subscriptions/${adaBooking}/cancel"`,
      "Cancel subscription",
    ]);
    expect(bob).not.toContain("Cancel subscription");
  });

  test("shows a manager no cancel button and no warning", async () => {
    await subscribe("Ada", MONTHLY);
    const html = await pageHtml(
      "/admin/subscriptions",
      await createTestManagerSession(),
    );
    expect(html).not.toContain("Cancel subscription");
    expect(html).not.toContain("Warning: cancelling");
  });

  test("shows the owner each subscriber's payments, linked to their ledger", async () => {
    const { attendeeId } = await subscribe("Ada", MONTHLY);
    await renew("sub_ada");
    await postAttendeePayment(attendeeId);
    const html = await pageHtml("/admin/subscriptions");
    expectIncludesAll(html, [
      "<th>Payments</th>",
      "<th>Total paid</th>",
      "<th>Last payment</th>",
    ]);
    expectIncludesAll(tableRows(html)[0]!, [
      `<a href="/admin/ledger/attendee/${attendeeId}">2</a>`,
      "<td>£18.34</td>",
      "<td>2026-06-22 09:30</td>",
    ]);
  });

  test("shows a subscriber with no payment as none", async () => {
    const { attendeeId } = await subscribe("Ada", MONTHLY);
    expectIncludesAll(tableRows(await pageHtml("/admin/subscriptions"))[0]!, [
      `<a href="/admin/ledger/attendee/${attendeeId}">0</a>`,
      "<td>£0</td>",
      "<td>None</td>",
    ]);
  });

  test("counts only the payments of each subscriber", async () => {
    const ada = await subscribe("Ada", MONTHLY);
    const bob = await subscribe("Bob", MONTHLY);
    await postAttendeePayment(ada.attendeeId);
    const [bobRow, adaRow] = tableRows(await pageHtml("/admin/subscriptions"));
    expect(adaRow).toContain(
      `<a href="/admin/ledger/attendee/${ada.attendeeId}">1</a>`,
    );
    expect(bobRow).toContain(
      `<a href="/admin/ledger/attendee/${bob.attendeeId}">0</a>`,
    );
  });

  test("takes each refund off the total paid, but not off the count", async () => {
    const { attendeeId } = await subscribe("Ada", MONTHLY);
    await renew("sub_ada");
    await postAttendeePayment(attendeeId);
    await refundFive(attendeeId);
    expectIncludesAll(tableRows(await pageHtml("/admin/subscriptions"))[0]!, [
      `<a href="/admin/ledger/attendee/${attendeeId}">2</a>`,
      "<td>£13.34</td>",
      "<td>2026-06-22 09:30</td>",
    ]);
  });

  test("does not count a charge that the owner adds as a payment", async () => {
    const { attendeeId } = await subscribe("Ada", MONTHLY);
    await postAttendeePayment(attendeeId, "5.00", "manual_attendee_charge");
    expectIncludesAll(tableRows(await pageHtml("/admin/subscriptions"))[0]!, [
      `<a href="/admin/ledger/attendee/${attendeeId}">0</a>`,
      "<td>£0</td>",
    ]);
  });

  test("shows a manager no payments and no ledger link", async () => {
    const { attendeeId } = await subscribe("Ada", MONTHLY);
    await postAttendeePayment(attendeeId);
    const html = await pageHtml(
      "/admin/subscriptions",
      await createTestManagerSession(),
    );
    expect(html).not.toContain("<th>Payments</th>");
    expect(html).not.toContain("/admin/ledger/");
    expect(html).not.toContain("£12.34");
  });

  test("an editor cannot reach the page", async () => {
    expect(await editorGetStatus("/admin/subscriptions")).toBe(403);
  });

  test("the menu links to the page only while the feature is on", async () => {
    const link = 'href="/admin/subscriptions"';
    expect(await pageHtml("/admin/")).not.toContain(link);
    await withSetting(featureSetting("subscriptions"), async () => {
      expect(await pageHtml("/admin/")).toContain(link);
    });
  });
});
