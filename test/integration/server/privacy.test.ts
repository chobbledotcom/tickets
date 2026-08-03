/**
 * Tests for the admin Privacy page (GET render + the orphan-purge and GDPR
 * erasure POST handlers).
 *
 * These cover each arm of the two handlers directly, including the refusals no
 * rendered form could ever send: an age outside the dropdown's own list, and a
 * "find by" nothing on the page offers. The organiser's journey through the
 * same page is told in the story "The organiser keeps only the personal details
 * the site still needs", and a Cucumber run does not count towards coverage, so
 * the arms below stay covered here.
 *
 * Note on the background prune: most requests flush the fire-and-forget prune
 * scheduler before responding, but POST /admin/privacy/orphans deliberately
 * skips it (see prepareRequestEnvironment) so a request that changes the
 * retention or switches auto-purge off is never raced by a purge enqueued with
 * the pre-change settings. The purge test relies on that: it leaves auto-purge
 * on (its default) and asserts the *handler* — not a background prune —
 * decides an old orphan's fate.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { parseFlashValue } from "#shared/cookies.ts";
import { queryOne } from "#shared/db/client.ts";
import { hashEmail } from "#shared/db/contact-preferences.ts";
import { settings } from "#shared/db/settings.ts";
import { nowMs } from "#shared/now.ts";
import {
  cachedAdminPage,
  expectFlashRedirect,
  expectStatus,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { setContactVisits } from "#test-utils/contact-preferences.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  attendeeExists as attendeeExistsHelper,
  insertOrphanAttendee,
} from "#test-utils/db-helpers/attendees.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";
import {
  adminFormPost,
  createTestManagerSession,
} from "#test-utils/session.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const oldIso = (): string => new Date(nowMs() - 365 * DAY_MS).toISOString();

/** Insert an orphan attendee with `createdIso`. */
const insertOrphan = async (createdIso: string): Promise<number> => {
  const daysAgo = Math.round(
    (nowMs() - new Date(createdIso).getTime()) / DAY_MS,
  );
  return insertOrphanAttendee(daysAgo, "priv-orphan");
};

const attendeeExists = async (id: number): Promise<boolean> =>
  attendeeExistsHelper(id);

const preferenceExists = async (hash: string): Promise<boolean> =>
  (await queryOne<{ one: number }>(
    "SELECT 1 AS one FROM contact_preferences WHERE contact_hash = ?",
    [hash],
  )) !== null;

/** Read the info-level flash message from a redirect response. */
const flashInfo = (response: Response): string | undefined => {
  const cookie = response.headers
    .getSetCookie()
    .find((c) => c.startsWith("flash_"));
  const value = (cookie?.split(";")[0] ?? "").split("=").slice(1).join("=");
  return parseFlashValue(value).info;
};

describeWithEnv("server (admin privacy)", { db: true }, () => {
  describe("GET /admin/privacy", () => {
    testRequiresAuth("/admin/privacy");

    // Assertions about the page's default state share one render.
    const page = cachedAdminPage("/admin/privacy");

    test("returns 403 for a non-owner", async () => {
      const response = await awaitTestRequest("/admin/privacy", {
        cookie: await createTestManagerSession(),
      });
      expectStatus(403)(response);
    });

    test("says it is a ticketing system, not a CRM", async () => {
      await page("not a CRM");
    });

    test("links to webhook setup so a CRM can be connected", async () => {
      await page("add a webhook to a listing", 'href="/admin/guide#webhooks"');
    });

    test("recognises by a one-way code that excludes the email and phone", async () => {
      await page("one-way code");
      await page("not the email or phone itself");
    });

    test("says contact details stay in the encrypted booking, not just the code", async () => {
      await page("stay with the booking, kept encrypted");
    });
  });

  describe("POST /admin/privacy/orphans", () => {
    testRequiresAuth("/admin/privacy/orphans", {
      body: { retention: "182" },
      method: "POST",
    });

    // A year-old orphan is the point: auto-purge is on by default and the
    // orphan prune is due on a fresh database, so a save that let the scheduler
    // run would reap this record under the previous 182-day retention. The
    // story beside this ("The organiser keeps only the personal details the
    // site still needs") cannot set that up — every booking it makes is made
    // just now — so the sharp version of the claim lives here.
    test("saving with auto-purge switched off does not purge with the old settings", async () => {
      const id = await insertOrphan(oldIso());

      const { response } = await adminFormPost("/admin/privacy/orphans", {
        action: "save",
        retention: "1825",
      });

      await expectFlashRedirect(
        "/admin/privacy",
        "Saved your orphaned-record settings.",
      )(response);
      expect(settings.orphanPurgeRetention).toBe("1825");
      expect(settings.autoPurgeOrphans).toBe(false);
      expect(await attendeeExists(id)).toBe(true);
    });

    test("keeps auto-purge on when the checkbox is ticked", async () => {
      const { response } = await adminFormPost("/admin/privacy/orphans", {
        action: "save",
        auto_purge: "1",
        retention: "182",
      });

      expect(response.status).toBe(302);
      expect(settings.autoPurgeOrphans).toBe(true);
    });

    // The only direct cover of this handler's Purge arm. The story "The
    // organiser keeps only the personal details the site still needs" tells the
    // same journey in the organiser's own words, and a Cucumber run does not
    // count towards coverage.
    test("deletes matching orphans now, on Purge", async () => {
      const id = await insertOrphan(oldIso());

      const { response } = await adminFormPost("/admin/privacy/orphans", {
        action: "purge",
        retention: "182",
      });

      await expectFlashRedirect(
        "/admin/privacy",
        "Deleted 1 orphaned record.",
      )(response);
      expect(await attendeeExists(id)).toBe(false);
    });

    test("rejects an invalid retention value", async () => {
      const { response } = await adminFormPost("/admin/privacy/orphans", {
        action: "save",
        retention: "abc",
      });

      await expectFlashRedirect(
        "/admin/privacy",
        "Please choose how old records must be before they are deleted.",
        false,
      )(response);
    });
  });

  describe("POST /admin/privacy/erase", () => {
    testRequiresAuth("/admin/privacy/erase", {
      body: { contact_type: "email", identifier: "x@example.com" },
      method: "POST",
    });

    // These three are the only direct cover of this handler's three arms. The
    // story "The organiser keeps only the personal details the site still
    // needs" tells the same journeys in the organiser's own words, and a
    // Cucumber run does not count towards coverage.
    test("erases a contact record found by email", async () => {
      const hash = await hashEmail("erase-me@example.com");
      await setContactVisits(hash, 1);

      const { response } = await adminFormPost("/admin/privacy/erase", {
        contact_type: "email",
        identifier: "erase-me@example.com",
      });

      await expectFlashRedirect(
        "/admin/privacy",
        "Deleted that contact's record.",
      )(response);
      expect(await preferenceExists(hash)).toBe(false);
    });

    test("reports when no record matched", async () => {
      const { response } = await adminFormPost("/admin/privacy/erase", {
        contact_type: "email",
        identifier: "nobody@example.com",
      });

      expect(flashInfo(response)).toBe(
        "No record was found for that email or phone, so there was nothing to delete.",
      );
    });

    test("rejects a blank identifier", async () => {
      const { response } = await adminFormPost("/admin/privacy/erase", {
        contact_type: "email",
        identifier: "   ",
      });

      await expectFlashRedirect(
        "/admin/privacy",
        "Please enter the email address or phone number to delete.",
        false,
      )(response);
    });

    test("rejects an unknown contact type", async () => {
      const { response } = await adminFormPost("/admin/privacy/erase", {
        contact_type: "fax",
        identifier: "123456",
      });

      await expectFlashRedirect(
        "/admin/privacy",
        "Please choose whether you are entering an email or a phone number.",
        false,
      )(response);
    });
  });
});
