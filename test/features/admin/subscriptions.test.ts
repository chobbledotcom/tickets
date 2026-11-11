/** The Subscriptions page: who subscribed, to what, and its Stripe status. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute } from "#db/client.ts";
import { expectIncludesAll } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";
import {
  adminGet,
  createTestManagerSession,
  editorGetStatus,
} from "#test-utils/session.ts";
import { featureSetting, withSetting } from "#test-utils/settings.ts";

/** A booking for `name` on a new listing of its own. */
const book = async (name: string): Promise<number> => {
  const listing = await createTestListing({
    maxAttendees: 10,
    name: `${name} Club`,
    unitPrice: 1000,
  });
  const attendee = await createTestAttendee(
    listing.id,
    listing.slug,
    name,
    `${name.toLowerCase()}@example.com`,
  );
  return attendee.id;
};

/** A booking for `name` that carries a Stripe plan. */
const subscribe = async (
  name: string,
  plan: { interval: string; price: number; status: string; tax: number },
): Promise<number> => {
  const attendeeId = await book(name);
  await execute(
    `UPDATE listing_attendees
        SET recurring_interval = ?, recurring_price = ?, recurring_tax = ?,
            subscription_id = ?, subscription_status = ?
      WHERE attendee_id = ?`,
    [
      plan.interval,
      plan.price,
      plan.tax,
      `sub_${name.toLowerCase()}`,
      plan.status,
      attendeeId,
    ],
  );
  return attendeeId;
};

const MONTHLY = { interval: "month", price: 600, status: "trialing", tax: 100 };

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

describeWithEnv("server (admin subscriptions)", { db: true }, () => {
  test("says nobody has subscribed yet", async () => {
    expectIncludesAll(await pageHtml("/admin/subscriptions"), [
      "<title>Subscriptions",
      "Nobody has bought a subscription ticket yet.",
    ]);
  });

  test("lists each subscriber with the plan and status Stripe reported, newest first", async () => {
    const ada = await subscribe("Ada", MONTHLY);
    const bob = await subscribe("Bob", {
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

  test("leaves out bookings that never subscribed", async () => {
    await book("Cy");
    expect(tableRows(await pageHtml("/admin/subscriptions"))).toEqual([]);
  });

  test("a manager can open the page", async () => {
    await subscribe("Ada", MONTHLY);
    const cookie = await createTestManagerSession();
    expect(await pageHtml("/admin/subscriptions", cookie)).toContain(
      ">Ada</a>",
    );
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
