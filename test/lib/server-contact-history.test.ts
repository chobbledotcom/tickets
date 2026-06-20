import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { execute } from "#shared/db/client.ts";
import {
  getContactRecord,
  hashEmail,
  saveContactRecord,
  toContactHashParam,
} from "#shared/db/contact-preferences.ts";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import {
  adminFormPost,
  awaitTestRequest,
  describeWithEnv,
  expectRedirect,
  getTestPrivateKey,
  testCookie,
  testRequiresAuth,
} from "#test-utils";

const seededRecord = (overrides: Record<string, unknown> = {}) => ({
  adminBookingCount: 0,
  adminNotes: "",
  contactCount: 0,
  lastContact: "",
  lastSubject: "",
  publicBookingCount: 0,
  visits: 0,
  ...overrides,
});

describeWithEnv("server (/admin/history/:hmac)", { db: true }, () => {
  describe("GET", () => {
    testRequiresAuth("/admin/history/somehash");

    test("renders the editor with the contact's counts, last-contacted and markdown note", async () => {
      const hash = await hashEmail("editme@example.com");
      await saveContactRecord(
        hash,
        seededRecord({
          adminBookingCount: 2,
          adminNotes: "**VIP** note",
          contactCount: 4,
          lastContact: "2026-06-01T10:00:00.000Z",
          lastSubject: "Hello",
          publicBookingCount: 5,
          visits: 9,
        }),
      );

      const param = toContactHashParam(hash);
      const response = await awaitTestRequest(`/admin/history/${param}`, {
        cookie: await testCookie(),
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Contact record");
      // The plaintext counters are pre-filled into their number inputs.
      expect(html).toMatch(/name="public_booking_count"[^>]*value="5"/);
      expect(html).toMatch(/name="admin_booking_count"[^>]*value="2"/);
      expect(html).toMatch(/name="visits"[^>]*value="9"/);
      // A known last-contacted time is rendered (not the "Never" placeholder).
      expect(html).not.toContain("Never");
      // The private note is shown rendered as markdown (bold), not raw.
      expect(html).toContain("<strong>VIP</strong> note");
      // The URL-safe HMAC keying the record is shown to the operator.
      expect(html).toContain(param);
    });

    test("renders an empty record with a 'Never' placeholder and no note preview", async () => {
      // An unseen hash has no row at all, so every field is zero/empty.
      const param = toContactHashParam(await hashEmail("unseen@example.com"));
      const response = await awaitTestRequest(`/admin/history/${param}`, {
        cookie: await testCookie(),
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Contact record");
      expect(html).toMatch(/name="visits"[^>]*value="0"/);
      // No note → no markdown preview section, and last-contacted reads "Never".
      expect(html).toContain("Never");
      expect(html).not.toContain("Note preview");
    });
  });

  describe("POST", () => {
    test("overwrites the counts and note, redirecting back to the editor", async () => {
      const pk = await getTestPrivateKey();
      const hash = await hashEmail("saveme@example.com");
      const param = toContactHashParam(hash);
      const { response } = await adminFormPost(`/admin/history/${param}`, {
        admin_booking_count: "3",
        admin_notes: "Updated **note**",
        last_subject: "Subject",
        messages: "7",
        public_booking_count: "11",
        visits: "13",
      });
      expectRedirect(response, `/admin/history/${param}`);

      const record = await getContactRecord(hash, pk);
      expect(record.publicBookingCount).toBe(11);
      expect(record.adminBookingCount).toBe(3);
      expect(record.contactCount).toBe(7);
      expect(record.visits).toBe(13);
      expect(record.adminNotes).toBe("Updated **note**");
      expect(record.lastSubject).toBe("Subject");
    });

    test("coerces blank/negative counters to zero", async () => {
      const pk = await getTestPrivateKey();
      const hash = await hashEmail("coerce@example.com");
      await adminFormPost(`/admin/history/${toContactHashParam(hash)}`, {
        admin_booking_count: "-5",
        public_booking_count: "",
        visits: "4",
      });
      const record = await getContactRecord(hash, pk);
      expect(record.publicBookingCount).toBe(0);
      expect(record.adminBookingCount).toBe(0);
      expect(record.visits).toBe(4);
    });

    test("editing one contact's record leaves another's untouched", async () => {
      const pk = await getTestPrivateKey();
      const target = await hashEmail("target@example.com");
      const other = await hashEmail("other@example.com");
      await saveContactRecord(
        other,
        seededRecord({ adminNotes: "Other note" }),
      );

      await adminFormPost(`/admin/history/${toContactHashParam(target)}`, {
        admin_notes: "Target note",
        public_booking_count: "5",
      });

      // The unrelated contact's record is untouched...
      expect((await getContactRecord(other, pk)).adminNotes).toBe("Other note");
      // ...and only the targeted hash received the edit.
      const edited = await getContactRecord(target, pk);
      expect(edited.adminNotes).toBe("Target note");
      expect(edited.publicBookingCount).toBe(5);
    });

    test("rejects an over-long note and persists nothing", async () => {
      const pk = await getTestPrivateKey();
      const hash = await hashEmail("toolong@example.com");
      const { response } = await adminFormPost(
        `/admin/history/${toContactHashParam(hash)}`,
        {
          admin_notes: "x".repeat(MAX_TEXTAREA_LENGTH + 1),
          public_booking_count: "4",
        },
      );
      // Re-rendered in place with an error, not redirected.
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("characters or fewer");
      // The rejected submission wrote nothing.
      expect((await getContactRecord(hash, pk)).publicBookingCount).toBe(0);
    });
  });

  describe("corrupt record repair", () => {
    test("opens the editor and overwrites a row with an unreadable stats blob", async () => {
      const pk = await getTestPrivateKey();
      const hash = await hashEmail("repair@example.com");
      const param = toContactHashParam(hash);
      // A row whose encrypted note is corrupt, but whose plaintext counts are
      // intact — the exact state the best-effort SMS path can leave behind.
      await execute(
        "INSERT INTO contact_preferences (contact_hash, visits, public_booking_count, admin_booking_count, stats_blob, last_activity) VALUES (?, ?, ?, ?, ?, ?)",
        [hash, 9, 5, 2, "not-valid-ciphertext", Date.now()],
      );

      // The editor still renders (not a 500), and crucially pre-fills every
      // surviving plaintext count — a fallback that blanked them would let a
      // blind save zero a contact's real booking history.
      const getResponse = await awaitTestRequest(`/admin/history/${param}`, {
        cookie: await testCookie(),
      });
      expect(getResponse.status).toBe(200);
      const html = await getResponse.text();
      expect(html).toMatch(/name="visits"[^>]*value="9"/);
      expect(html).toMatch(/name="public_booking_count"[^>]*value="5"/);
      expect(html).toMatch(/name="admin_booking_count"[^>]*value="2"/);

      // Saving (resubmitting the pre-filled counts) overwrites the corrupt
      // blob with a fresh, readable note while keeping the counts intact.
      const { response } = await adminFormPost(`/admin/history/${param}`, {
        admin_booking_count: "2",
        admin_notes: "Repaired",
        last_subject: "",
        messages: "0",
        public_booking_count: "5",
        visits: "9",
      });
      expectRedirect(response, `/admin/history/${param}`);

      const record = await getContactRecord(hash, pk);
      expect(record.adminNotes).toBe("Repaired");
      expect(record.visits).toBe(9);
      expect(record.publicBookingCount).toBe(5);
      expect(record.adminBookingCount).toBe(2);
    });
  });
});
