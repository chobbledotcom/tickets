/** The Subscriptions page: who subscribed, to what, and its Stripe status. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { executeBatch, queryOne } from "#db/client.ts";
import { expectIncludesAll } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
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
import { featureSetting, withSetting } from "#test-utils/settings.ts";

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
      {
        args: [attendeeId],
        sql: "UPDATE listing_attendees SET quantity = 0 WHERE attendee_id = ?",
      },
      {
        args: [listingId],
        sql: "DELETE FROM listings WHERE id = ?",
      },
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
    const adaBooking = (await queryOne<{ id: number }>(
      "SELECT id FROM listing_attendees WHERE attendee_id = ?",
      [ada.attendeeId],
    ))!.id;
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
