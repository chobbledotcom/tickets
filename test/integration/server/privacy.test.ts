/** Privacy-page routes, including refusals the rendered forms cannot send.
 * Saving orphan settings skips the background prune so old settings cannot
 * race the request; the purge test therefore exercises the handler itself. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getDb, insert, queryOne } from "#db/client.ts";
import { hashEmail } from "#db/contact-preferences.ts";
import { deleteListing } from "#db/listings/delete.ts";
import { settings } from "#db/settings.ts";
import { parseFlashValue } from "#shared/cookies.ts";
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
  createTestAttendeeDirect,
  insertOrphanAttendee,
} from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";
import {
  CLAIM_MIRROR,
  freshClaimSlot,
  putRowState,
} from "#test-utils/payment-claim.ts";
import { recordQueries } from "#test-utils/record-queries.ts";
import {
  adminFormPost,
  adminGet,
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

/** Put one orphan in the owner-visible payment-recovery queue. */
const insertPaymentWorkOrphan = async (): Promise<number> => {
  const attendeeId = await insertOrphan(oldIso());
  await getDb().execute(
    insert("processed_payments", {
      attendee_id: attendeeId,
      payment_session_id: `privacy-page-${attendeeId}`,
      processed_at: oldIso(),
      protected_state: CLAIM_MIRROR,
    }),
  );
  return attendeeId;
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

    test("does not show an empty payment-work queue", async () => {
      expect(await page()).not.toContain("Outstanding payment work");
    });

    test("keeps payment work reachable after its last listing is deleted", async () => {
      const listing = await createTestListing();
      const { attendee } = await createTestAttendeeDirect(
        listing.id,
        "Refund recovery",
        "refund-recovery@example.com",
      );
      const paymentSessionId = `privacy-recovery-${attendee.id}`;
      await getDb().execute(
        insert("processed_payments", {
          attendee_id: attendee.id,
          payment_session_id: paymentSessionId,
          processed_at: oldIso(),
        }),
      );
      await putRowState(
        paymentSessionId,
        await freshClaimSlot(attendee.id),
        CLAIM_MIRROR,
      );

      await deleteListing(listing.id);

      const response = await adminGet("/admin/privacy");
      const html = await response.text();
      expect(response.status).toBe(200);
      expect(html).toContain("The normal cleanup queue is empty right now.");
      expect(html).not.toContain("There are no orphaned records right now.");
      expect(html).toContain("Outstanding payment work");
      expect(html).toContain(`href="/admin/attendees/${attendee.id}"`);
      expect(html).toContain(`Open attendee ${attendee.id}`);
      expect((await adminGet(`/admin/attendees/${attendee.id}`)).status).toBe(
        200,
      );
    });

    test("pages the payment-work queue without loading attendee PII", async () => {
      await getDb().execute(
        "UPDATE processed_payments SET protected_state = ''",
      );
      const attendeeIds = await Promise.all(
        Array.from({ length: 41 }, () => insertPaymentWorkOrphan()),
      );
      const queries: string[] = [];
      const restore = recordQueries(queries);
      let first: Response;
      try {
        first = await adminGet("/admin/privacy");
      } finally {
        restore();
      }
      const firstHtml = await first.text();
      for (const attendeeId of attendeeIds.slice(0, 20)) {
        expect(firstHtml).toContain(`href="/admin/attendees/${attendeeId}"`);
      }
      expect(firstHtml).not.toContain(
        `href="/admin/attendees/${attendeeIds[20]}"`,
      );
      expect(firstHtml).toContain(
        `href="/admin/privacy?work_after=${attendeeIds[19]}"`,
      );
      expect(firstHtml).toContain('rel="next"');
      expect(firstHtml).not.toContain('rel="prev"');

      const queueQueries = queries.filter((sql) =>
        sql.includes("SELECT DISTINCT payment.attendee_id AS id"),
      );
      expect(queueQueries).toHaveLength(1);
      expect(queueQueries[0]).toContain("LIMIT ?");
      expect(queueQueries[0]).not.toContain("pii_blob");

      const second = await adminGet(
        `/admin/privacy?work_after=${attendeeIds[19]}`,
      );
      const secondHtml = await second.text();
      for (const attendeeId of attendeeIds.slice(20, 40)) {
        expect(secondHtml).toContain(`href="/admin/attendees/${attendeeId}"`);
      }
      expect(secondHtml).not.toContain(
        `href="/admin/attendees/${attendeeIds[19]}"`,
      );
      expect(secondHtml).toContain(
        `href="/admin/privacy?work_before=${attendeeIds[20]}"`,
      );
      expect(secondHtml).toContain(
        `href="/admin/privacy?work_after=${attendeeIds[39]}"`,
      );
      expect(secondHtml).toContain('rel="prev"');
      expect(secondHtml).toContain('rel="next"');

      const last = await adminGet(
        `/admin/privacy?work_after=${attendeeIds[39]}`,
      );
      const lastHtml = await last.text();
      expect(lastHtml).toContain(`href="/admin/attendees/${attendeeIds[40]}"`);
      expect(lastHtml).toContain(
        `href="/admin/privacy?work_before=${attendeeIds[40]}"`,
      );
      expect(lastHtml).not.toContain('rel="next"');

      const previous = await adminGet(
        `/admin/privacy?work_before=${attendeeIds[40]}`,
      );
      const previousHtml = await previous.text();
      expect(previousHtml).toContain(
        `href="/admin/attendees/${attendeeIds[20]}"`,
      );
      expect(previousHtml).toContain(
        `href="/admin/privacy?work_before=${attendeeIds[20]}"`,
      );
      expect(previousHtml).toContain('rel="prev"');
      expect(previousHtml).toContain('rel="next"');

      const firstAgain = await adminGet(
        `/admin/privacy?work_before=${attendeeIds[20]}`,
      );
      const firstAgainHtml = await firstAgain.text();
      expect(firstAgainHtml).toContain(
        `href="/admin/attendees/${attendeeIds[0]}"`,
      );
      expect(firstAgainHtml).toContain('rel="next"');
      expect(firstAgainHtml).not.toContain('rel="prev"');
    });

    test("defaults malformed payment-work cursors to the first page", async () => {
      const attendeeId = await insertPaymentWorkOrphan();
      const response = await adminGet(
        "/admin/privacy?work_after=not-an-id&work_before=also-not-an-id",
      );
      expect(await response.text()).toContain(
        `href="/admin/attendees/${attendeeId}"`,
      );
    });

    test("keeps a way back from empty out-of-range cursor pages", async () => {
      const attendeeId = await insertPaymentWorkOrphan();
      const highCursor = attendeeId + 1_000;
      const afterEnd = await adminGet(
        `/admin/privacy?work_after=${highCursor}`,
      );
      const afterEndHtml = await afterEnd.text();
      expect(afterEndHtml).toContain("There are no records on this page.");
      expect(afterEndHtml).toContain(
        `href="/admin/privacy?work_before=${highCursor + 1}"`,
      );
      expect(afterEndHtml).toContain('rel="prev"');
      expect(afterEndHtml).not.toContain("undefined");
      expect(
        await (
          await adminGet(`/admin/privacy?work_before=${highCursor + 1}`)
        ).text(),
      ).toContain(`href="/admin/attendees/${attendeeId}"`);

      const beforeStart = await adminGet(
        `/admin/privacy?work_before=${attendeeId}`,
      );
      const beforeStartHtml = await beforeStart.text();
      expect(beforeStartHtml).toContain("There are no records on this page.");
      expect(beforeStartHtml).toContain(
        `href="/admin/privacy?work_after=${attendeeId - 1}"`,
      );
      expect(beforeStartHtml).toContain('rel="next"');
      expect(beforeStartHtml).not.toContain("undefined");
      expect(
        await (
          await adminGet(`/admin/privacy?work_after=${attendeeId - 1}`)
        ).text(),
      ).toContain(`href="/admin/attendees/${attendeeId}"`);
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
