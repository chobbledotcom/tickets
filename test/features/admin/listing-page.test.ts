/**
 * The listing record page: which tabs and actions each role and each listing
 * state gets. Every entry repeats the gate its target route enforces, so a
 * link that renders is always one the viewer can follow.
 */

import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { listingsTable } from "#db/listings/records.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";
import { has, says } from "#test-utils/says.ts";
import {
  adminFormPost,
  adminGet,
  createTestEditorSession,
  createTestManagerSession,
} from "#test-utils/session.ts";

const tabsOf = (html: string, id: number): string[] =>
  [...html.matchAll(new RegExp(`href="/admin/listing/${id}/(\\w+)"`, "g"))].map(
    (match) => match[1]!,
  );

describeWithEnv("the listing page", { db: true }, () => {
  test("opens on the overview and names the listing", async () => {
    const listing = await createTestListing({ name: "Castle Hire" });

    const response = await adminGet(`/admin/listing/${listing.id}`);
    const html = await response.text();

    expect(response.status).toBe(200);
    says(html, "<h1>Listing: Castle Hire</h1>");
    has(tabsOf(html, listing.id), "attendees");
  });

  test("marks the listings list as the section it belongs to", async () => {
    const listing = await createTestListing({ name: "Section" });

    const html = await (await adminGet(`/admin/listing/${listing.id}`)).text();

    says(html, `<a class="active" href="/admin/listings">`);
  });

  test("opens an editor on edit and keeps the attendee tabs shut", async () => {
    const listing = await createTestListing({ name: "Editor View" });
    const { cookie } = await createTestEditorSession();

    const page = await awaitTestRequest(`/admin/listing/${listing.id}`, {
      cookie,
    });
    const attendees = await awaitTestRequest(
      `/admin/listing/${listing.id}/attendees`,
      { cookie },
    );

    expect(page.status).toBe(200);
    says(
      await page.text(),
      `<a aria-current="page" class="active" href="/admin/listing/${listing.id}/edit">Edit</a>`,
    );
    expect(attendees.status).toBe(404);
  });

  test("offers deactivate on a live listing and reactivate on a dead one", async () => {
    // The two are opposites, so exactly one is ever offered.
    const listing = await createTestListing({ name: "Lifecycle" });
    const actions = async () =>
      await (await adminGet(`/admin/listing/${listing.id}/actions`)).text();

    const live = await actions();
    await adminFormPost(`/admin/listing/${listing.id}/deactivate`, {
      confirm_identifier: listing.name,
    });
    const dead = await actions();

    says(live, `href="/admin/listing/${listing.id}/deactivate"`);
    assert(!live.includes(`href="/admin/listing/${listing.id}/reactivate"`));
    expect(
      (await listingsTable.read.pick(["active"]).one({ id: listing.id }))!
        .active,
    ).toBe(false);
    says(dead, `href="/admin/listing/${listing.id}/reactivate"`);
    assert(!dead.includes(`href="/admin/listing/${listing.id}/deactivate"`));
  });

  test("keeps delete and refund from an editor, and offers them export", async () => {
    const listing = await createTestListing({ name: "Editor Actions" });
    const { cookie } = await createTestEditorSession();

    const html = await (
      await awaitTestRequest(`/admin/listing/${listing.id}/actions`, { cookie })
    ).text();

    says(html, `href="/admin/listing/${listing.id}/export.json"`);
    says(html, `href="/admin/listing/${listing.id}/duplicate"`);
    assert(!html.includes(`href="/admin/listing/${listing.id}/delete"`));
    assert(!html.includes(`href="/admin/listing/${listing.id}/refund-all"`));
  });

  test("keeps the owner-only actions from a manager", async () => {
    // Emailing and refunding move money or reach customers, so both stay with
    // the owner even though a manager is staff.
    const listing = await createTestListing({ name: "Manager Actions" });
    const cookie = await createTestManagerSession();

    const html = await (
      await awaitTestRequest(`/admin/listing/${listing.id}/actions`, { cookie })
    ).text();

    says(html, `href="/admin/listing/${listing.id}/delete"`);
    assert(!html.includes(`href="/admin/listing/${listing.id}/refund-all"`));
    assert(!html.includes("/admin/emails?"));
  });

  test("answers 404 for a listing that is not there", async () => {
    expect((await adminGet("/admin/listing/99999")).status).toBe(404);
  });
});
