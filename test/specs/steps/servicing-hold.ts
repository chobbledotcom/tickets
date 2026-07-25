// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { getListingRemainingForRange } from "#shared/db/attendees/capacity/remaining.ts";
import {
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";
import { extractCsrfToken } from "#test-utils/csrf.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";
import {
  adminPost,
  assertRedirectPathname,
  createServicingEvent,
  renderAdminPage,
} from "#test-utils/servicing.ts";
import { enablePublicSite } from "#test-utils/settings.ts";
import { extractFormEntries } from "#test-utils/test-browser.ts";

// jscpd:ignore-end

const ROOM_A = "Room A";
const ANNUAL_ROOM = "Annual Room";
const BOILER_SERVICE = "Boiler Service";
const ANNUAL_INSPECTION = "Annual Inspection";

/** GET a rendered admin page and return its HTML and CSRF token. */
const getRenderedForm = async (
  path: string,
): Promise<{ csrfToken: string; html: string }> => {
  const html = await renderAdminPage(path);
  const csrfToken = extractCsrfToken(html);
  if (!csrfToken) throw new Error(`No CSRF token on ${path}`);
  return { csrfToken, html };
};

const findForms = (html: string): Array<{ action: string; body: string }> => {
  const re = /<form\s[^>]*action="([^"]*)"[^>]*>([\s\S]*?)<\/form>/gi;
  const forms: Array<{ action: string; body: string }> = [];
  for (const match of html.matchAll(re)) {
    forms.push({ action: match[1]!, body: match[2]! });
  }
  return forms;
};

/** Find the form whose submit button matches `buttonText`, submit it with
 *  `overrides` merged on top of the rendered fields. Drives through the
 *  real rendered form per the AGENTS.md guidance. */
const submitRenderedForm = async (
  path: string,
  buttonText: string,
  overrides: Record<string, string> = {},
): Promise<Response> => {
  const { csrfToken, html } = await getRenderedForm(path);
  const form = findForms(html).find((f) =>
    new RegExp(`>${buttonText}<`, "i").test(f.body),
  );
  if (!form) throw new Error(`No form with button "${buttonText}" on ${path}`);
  const params = new URLSearchParams();
  for (const [key, value] of extractFormEntries(form.body)) {
    params.append(key, value);
  }
  for (const [key, value] of Object.entries(overrides)) {
    params.set(key, value);
  }
  params.set("csrf_token", csrfToken);
  return adminPost(form.action, Object.fromEntries(params));
};

const createHoldViaProduction = async (
  world: TicketsWorld,
  listingName: string,
  holdName: string,
  listingOverrides: Record<string, string | number> = {},
): Promise<{ eventId: number; listingId: number }> => {
  const listing = await createTestListing({
    durationDays: 1,
    listingType: "daily",
    maxAttendees: 5,
    maximumDaysAfter: 365,
    maxQuantity: 5,
    name: listingName,
    ...listingOverrides,
  });
  const event = await createServicingEvent({
    bookings: [{ date: "2099-07-01", listingId: listing.id, quantity: 1 }],
    name: holdName,
  });
  world.servicingEventId = event.id;
  world.holdListingId = listing.id;
  return { eventId: event.id, listingId: listing.id };
};

Given(
  "an organiser has created a Boiler Service hold on Room A",
  async function (this: TicketsWorld): Promise<void> {
    await createHoldViaProduction(this, ROOM_A, BOILER_SERVICE, {
      maxAttendees: 1,
    });
  },
);

Given(
  "an organiser has created an Annual Inspection hold on Annual Room",
  async function (this: TicketsWorld): Promise<void> {
    await createHoldViaProduction(this, ANNUAL_ROOM, ANNUAL_INSPECTION, {
      maxAttendees: 10,
      maximumDaysAfter: 1000,
    });
  },
);

When(
  "the organiser duplicates the service event",
  async function (this: TicketsWorld): Promise<void> {
    const id = requiredWorldValue(this.servicingEventId, "service event id");
    await submitRenderedForm(`/admin/servicing/${id}`, "Duplicate");
  },
);

When(
  "the organiser deletes the service event",
  async function (this: TicketsWorld): Promise<void> {
    const id = requiredWorldValue(this.servicingEventId, "service event id");
    await submitRenderedForm(`/admin/servicing/${id}`, "Delete Service Event");
  },
);

When(
  "the organiser records a cost of 90.00 for Boiler Service",
  async function (this: TicketsWorld): Promise<void> {
    const id = requiredWorldValue(this.servicingEventId, "service event id");
    const response = await submitRenderedForm(
      `/admin/servicing/${id}`,
      "Record service event cost",
      {
        amount: "90.00",
        memo: "Boiler part",
      },
    );
    assertRedirectPathname(response, `/admin/servicing/${id}`);
  },
);

Then(
  "the admin dashboard shows the Boiler Service hold",
  async function (this: TicketsWorld): Promise<void> {
    const body = await renderAdminPage("/admin/");
    expect(body).toContain(BOILER_SERVICE);
  },
);

Then(
  "the admin dashboard shows two Annual Inspection holds",
  async function (this: TicketsWorld): Promise<void> {
    const body = await renderAdminPage("/admin/");
    const count = (body.match(/Annual Inspection/g) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(2);
  },
);

Then(
  "the admin dashboard no longer shows Boiler Service",
  async function (this: TicketsWorld): Promise<void> {
    const body = await renderAdminPage("/admin/");
    expect(body).not.toContain(BOILER_SERVICE);
  },
);

Then(
  "the public site does not show Boiler Service",
  async function (this: TicketsWorld): Promise<void> {
    await enablePublicSite();
    const response = await awaitTestRequest("/");
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toContain(BOILER_SERVICE);
  },
);

Then(
  "the service event page shows the recorded cost",
  async function (this: TicketsWorld): Promise<void> {
    const id = requiredWorldValue(this.servicingEventId, "service event id");
    const body = await renderAdminPage(`/admin/servicing/${id}`);
    expect(body).toContain(">£90<");
    expect(body).toContain("Boiler part");
  },
);

Then(
  "the held listing has its full capacity restored",
  async function (this: TicketsWorld): Promise<void> {
    const listingId = requiredWorldValue(this.holdListingId, "hold listing id");
    expect(await getListingRemainingForRange(listingId, "2099-07-01")).toBe(1);
  },
);
