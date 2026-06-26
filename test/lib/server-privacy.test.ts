/**
 * Tests for the admin Privacy page (GET render + the orphan-purge and GDPR
 * erasure POST handlers).
 *
 * Note on the background prune: most requests flush the fire-and-forget prune
 * scheduler before responding, but POST /admin/privacy/orphans deliberately
 * skips it (see prepareRequestEnvironment) so a request that changes the
 * retention or switches auto-purge off is never raced by a purge enqueued with
 * the pre-change settings. These tests rely on that: they leave auto-purge on
 * (its default) and assert the *handler* — not a background prune — decides an
 * old orphan's fate.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { parseFlashValue } from "#shared/cookies.ts";
import { queryOne } from "#shared/db/client.ts";
import {
  hashEmail,
  hashPhone,
  recordVisit,
} from "#shared/db/contact-preferences.ts";
import { settings } from "#shared/db/settings.ts";
import { nowMs } from "#shared/now.ts";
import {
  adminFormPost,
  adminGet,
  assertAdminHtml,
  attendeeExists as attendeeExistsHelper,
  awaitTestRequest,
  createTestManagerSession,
  describeWithEnv,
  expectFlashRedirect,
  expectHtmlResponse,
  expectStatus,
  insertOrphanAttendee,
  testRequiresAuth,
} from "#test-utils";

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

    test("returns 403 for a non-owner", async () => {
      const response = await awaitTestRequest("/admin/privacy", {
        cookie: await createTestManagerSession(),
      });
      expectStatus(403)(response);
    });

    test("renders the explainer and tools for the owner", async () => {
      const response = await adminGet("/admin/privacy");
      await expectHtmlResponse(
        response,
        200,
        "Privacy",
        "not a CRM",
        "private fingerprint",
        "Delete matching records now",
      );
    });

    test("reports the current orphan count", async () => {
      await insertOrphan(new Date(nowMs()).toISOString());
      await assertAdminHtml(
        "/admin/privacy",
        "There is 1 orphaned record right now.",
      );
    });
  });

  describe("POST /admin/privacy/orphans", () => {
    testRequiresAuth("/admin/privacy/orphans", {
      body: { retention: "182" },
      method: "POST",
    });

    test("saving with auto-purge switched off does not purge with the old settings", async () => {
      // Auto-purge is on by default and the orphan prune is due (fresh DB), so
      // unless this route skips the scheduler, the request that turns auto-purge
      // off would still reap this old orphan with the previous retention.
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

    test("erases a contact record found by email", async () => {
      const hash = await hashEmail("erase-me@example.com");
      await recordVisit(hash);

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

    test("erases a contact record found by phone", async () => {
      const hash = await hashPhone("07700 900222");
      await recordVisit(hash);

      const { response } = await adminFormPost("/admin/privacy/erase", {
        contact_type: "sms",
        identifier: "07700 900222",
      });

      expect(response.status).toBe(302);
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
