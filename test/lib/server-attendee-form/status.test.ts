import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  attendeeStatuses,
  getPaidDefaultStatus,
} from "#shared/db/attendee-statuses.ts";
import { getAttendeeBalanceState } from "#shared/db/attendees/balance.ts";
import { createAttendeeAtomic } from "#shared/db/attendees.ts";
import { getDb } from "#shared/db/client.ts";
import {
  getContactRecord,
  hashEmail,
  saveContactRecord,
  toContactHashParam,
} from "#shared/db/contact-preferences.ts";
import {
  adminFormPost,
  adminGet,
  attendeeLineFields,
  buildAttendeeEditForm,
  createTestAttendee,
  createTestListing,
  describeWithEnv,
  expectHtmlResponse,
  getTestPrivateKey,
  hasSelectedOption,
} from "#test-utils";
import { postListingSale } from "#test-utils/ledger.ts";

describeWithEnv(
  "server (unified attendee form) — status, balance & tabs",
  { db: true },
  () => {
    describe("status & balance", () => {
      /** Create an attendee with one £10 line, paying `pricePaid` of it. */
      const seedAttendee = async (
        statusId: number | null,
        remainingBalance: number,
        pricePaid = 100,
      ): Promise<number> => {
        const listing = await createTestListing({
          maxAttendees: 10,
          unitPrice: 1000,
        });
        const created = await createAttendeeAtomic({
          bookings: [{ listingId: listing.id, pricePaid, quantity: 1 }],
          email: "r@example.com",
          name: "Reserver",
          remainingBalance,
          statusId,
        });
        if (!created.success) throw new Error("setup failed");
        // Both amount paid and outstanding balance project from the ledger now:
        // post the gross sale (deposit + owed) and the deposit payment, so the
        // attendee has paid `pricePaid` and owes `remainingBalance` in the ledger.
        const gross = pricePaid + remainingBalance;
        if (gross > 0) {
          await postListingSale({
            amountPaid: pricePaid,
            attendeeId: created.attendees[0]!.id,
            gross,
            listingId: listing.id,
          });
        }
        return created.attendees[0]!.id;
      };

      const newReservation = () =>
        attendeeStatuses.table.insert({
          isReservation: true,
          name: "Reserved",
          reservationAmount: "10%",
        });

      const getEdit = async (id: number): Promise<string> => {
        const response = await adminGet(`/admin/attendees/${id}/edit`);
        return expectHtmlResponse(response, 200);
      };

      test("edit persists an updated status; the balance is ledger-driven, not form-set", async () => {
        const reservation = await newReservation();
        const id = await seedAttendee(null, 0);
        const form = await buildAttendeeEditForm(id, {
          extra: { status_id: String(reservation.id) },
          name: "Reserver",
        });
        const { response } = await adminFormPost(
          `/admin/attendees/${id}`,
          form,
        );
        expect([302, 303]).toContain(response.status);

        const state = await getAttendeeBalanceState(id);
        expect(state?.statusId).toBe(reservation.id);
        // The form no longer edits the balance — it stays whatever the ledger
        // projects (0 here), adjusted only through the ledger itself.
        expect(state?.remainingBalance).toBe(0);
      });

      test("edit coerces a blank status back to the public default, not null", async () => {
        // The form offers no "no status" choice, so a blank status_id (only
        // reachable from a hand-crafted POST) must not clear the attendee — it
        // falls back to the public default instead.
        const reservation = await newReservation(); // a second, non-default status
        const publicDefault = await getPaidDefaultStatus(); // the seed is also public default
        const id = await seedAttendee(reservation.id, 1500);
        const form = await buildAttendeeEditForm(id, {
          extra: { status_id: "" },
          name: "Reserver",
        });
        await adminFormPost(`/admin/attendees/${id}`, form);

        const state = await getAttendeeBalanceState(id);
        expect(state?.statusId).toBe(publicDefault!.id);
        // The edit leaves the ledger balance untouched.
        expect(state?.remainingBalance).toBe(1500);
      });

      test("edit page warns when a paid status still owes a balance", async () => {
        const paid = await getPaidDefaultStatus();
        const id = await seedAttendee(paid!.id, 1500);
        const html = await getEdit(id);
        expect(html).toContain("paid status but still owes");
      });

      test("edit page warns when a reservation has lost its balance", async () => {
        // £1 deposit paid on the £10 order, but the balance was cleared to £0.
        const reservation = await newReservation();
        const id = await seedAttendee(reservation.id, 0);
        const html = await getEdit(id);
        expect(html).toContain("still unpaid");
      });

      test("edit page nudges to move a fully-paid reservation on", async () => {
        const reservation = await newReservation();
        const id = await seedAttendee(reservation.id, 0, 1000); // paid in full
        const html = await getEdit(id);
        expect(html).toContain("consider moving it to a paid status");
        expect(html).toContain('class="info"');
      });

      test("edit page stays quiet for a reservation that still owes a balance", async () => {
        const reservation = await newReservation();
        const id = await seedAttendee(reservation.id, 900);
        const html = await getEdit(id);
        // No notice — this is the normal mid-reservation state (balance owed, not
        // yet paid). The balance itself is not shown as an editable field.
        expect(html).not.toContain("still unpaid");
        expect(html).not.toContain("consider moving");
      });

      test("edit page stays quiet when nothing is owed", async () => {
        const id = await seedAttendee(null, 0);
        const html = await getEdit(id);
        expect(html).not.toContain("still unpaid");
        expect(html).not.toContain("paid status but still owes");
      });

      test("edit page shows the attendee's status as a heading when multiple statuses exist", async () => {
        const reservation = await newReservation();
        const id = await seedAttendee(reservation.id, 900);
        const html = await getEdit(id);
        expect(html).toContain("<h2>Status: Reserved</h2>");
      });

      test("edit page status heading reads None when the attendee has no status", async () => {
        await newReservation(); // a second status, so the heading is shown
        const id = await seedAttendee(null, 0);
        const html = await getEdit(id);
        expect(html).toContain("<h2>Status: None</h2>");
      });

      test("edit page omits the status heading when only one status exists", async () => {
        // Fresh installs seed a single status, which carries no information.
        const id = await seedAttendee(null, 0);
        const html = await getEdit(id);
        expect(html).not.toContain("<h2>Status:");
      });

      test("edit page status select offers no 'no status' option", async () => {
        const reservation = await newReservation(); // a second status, so the select is shown
        const id = await seedAttendee(reservation.id, 0);
        const html = await getEdit(id);
        // The empty placeholder choice is gone entirely.
        expect(html).not.toContain("No status");
        // The status select itself has no empty-value option any more.
        expect(html).not.toContain(
          '<select id="status_id" name="status_id"><option selected value="">',
        );
      });

      test("edit page pre-selects the public default when the attendee has no status", async () => {
        await newReservation(); // a second status, so the select is shown
        const defaultStatus = await getPaidDefaultStatus(); // also the public default seed
        const id = await seedAttendee(null, 0); // attendee has no status
        const html = await getEdit(id);
        expect(hasSelectedOption(html, String(defaultStatus!.id))).toBe(true);
      });

      test("edit page submits the lone status as a hidden field (no dropdown)", async () => {
        const only = await getPaidDefaultStatus(); // the single seeded status
        const id = await seedAttendee(only!.id, 0);
        const html = await getEdit(id);
        // No status dropdown is rendered for a single-status site...
        expect(html).not.toContain('<select id="status_id"');
        expect(html).not.toContain("No status");
        // ...but the status is still submitted so a save can't clear it.
        expect(html).toContain(
          `<input name="status_id" type="hidden" value="${only!.id}">`,
        );
      });
    });

    // The attendee form writes booking stats but must never write contact notes
    // (those are edited only on /admin/history). These guard the persisted
    // contact_preferences side effects through a real form POST — the layer where
    // the original blob bugs (leaked/overwritten notes, uncounted bookings) lived.
    describe("contact_preferences side effects", () => {
      const seededRecord = (adminNotes: string) => ({
        adminBookingCount: 0,
        adminNotes,
        contactCount: 0,
        lastContact: "",
        lastSubject: "",
        publicBookingCount: 0,
        visits: 0,
      });

      test("admin create records an admin booking against the email contact", async () => {
        const listing = await createTestListing({
          maxAttendees: 100,
          maxQuantity: 5,
        });
        const { response } = await adminFormPost("/admin/attendees/new", {
          email: "newbuyer@example.com",
          name: "New Buyer",
          ...attendeeLineFields([
            { eventId: listing.id, quantity: Number("1") },
          ]),
        });
        expect(response.status).toBe(302);
        const record = await getContactRecord(
          await hashEmail("newbuyer@example.com"),
          await getTestPrivateKey(),
        );
        // Counted as an admin booking, never an online one.
        expect(record.adminBookingCount).toBe(1);
        expect(record.publicBookingCount).toBe(0);
      });

      test("creating a second attendee with an existing email keeps that contact's note", async () => {
        const listing = await createTestListing({
          maxAttendees: 100,
          maxQuantity: 5,
        });
        const pk = await getTestPrivateKey();
        const hash = await hashEmail("repeat@example.com");
        // The contact already carries an operator note from a prior interaction.
        await saveContactRecord(hash, seededRecord("Existing VIP note"));

        const { response } = await adminFormPost("/admin/attendees/new", {
          email: "repeat@example.com",
          name: "Repeat Customer",
          ...attendeeLineFields([
            { eventId: listing.id, quantity: Number("1") },
          ]),
        });
        expect(response.status).toBe(302);

        const record = await getContactRecord(hash, pk);
        // The blank form does NOT clobber the stored note (the old create bug)...
        expect(record.adminNotes).toBe("Existing VIP note");
        // ...while the booking is still counted.
        expect(record.adminBookingCount).toBe(1);
      });

      test("changing an attendee's email on edit never copies the note onto the new email", async () => {
        const listing = await createTestListing({
          maxAttendees: 100,
          maxQuantity: 5,
        });
        const pk = await getTestPrivateKey();
        const aliceHash = await hashEmail("alice@example.com");
        const bobHash = await hashEmail("bob@example.com");
        // Alice's contact carries a private note; the attendee starts as Alice.
        await saveContactRecord(aliceHash, seededRecord("Alice private note"));
        const attendee = await createTestAttendee(
          listing.id,
          listing.slug,
          "Alice",
          "alice@example.com",
        );

        // Switch the attendee's email to Bob and save the form.
        const form = await buildAttendeeEditForm(attendee.id, {
          email: "bob@example.com",
          name: "Alice",
        });
        const { response } = await adminFormPost(
          `/admin/attendees/${attendee.id}`,
          form,
        );
        expect(response.status).toBe(302);

        // Bob's contact must NOT inherit Alice's note (the old leak bug)...
        expect((await getContactRecord(bobHash, pk)).adminNotes).toBe("");
        // ...and Alice's own note is left intact.
        expect((await getContactRecord(aliceHash, pk)).adminNotes).toBe(
          "Alice private note",
        );
      });

      test("keeps the repair link when a contact's stats_blob is corrupt", async () => {
        const listing = await createTestListing({
          maxAttendees: 100,
          maxQuantity: 5,
        });
        const attendee = await createTestAttendee(
          listing.id,
          listing.slug,
          "Corrupt Contact",
          "corrupt@example.com",
        );
        const hash = await hashEmail("corrupt@example.com");
        // Leave this contact's encrypted stats unreadable — the exact state the
        // best-effort SMS write path can persist — but keep recent activity so
        // the request's prune doesn't delete the row before it is read.
        await getDb().execute({
          args: [hash, Date.now()],
          sql: `INSERT INTO contact_preferences (contact_hash, stats_blob, last_activity) VALUES (?, 'corrupt-blob', ?)
              ON CONFLICT(contact_hash) DO UPDATE SET stats_blob = 'corrupt-blob', last_activity = excluded.last_activity`,
        });

        const response = await adminGet(`/admin/attendees/${attendee.id}`);
        // The page renders AND keeps the /admin/history repair link for the bad
        // row — dropping the channel would hide the only way to fix it.
        expect(response.status).toBe(200);
        expect(await response.text()).toContain(
          `/admin/history/${toContactHashParam(hash)}`,
        );
      });
    });

    describe("attendee page tabs", () => {
      test("an unknown tab slug 404s", async () => {
        const listing = await createTestListing({ maxAttendees: 10 });
        const attendee = await createTestAttendee(
          listing.id,
          listing.slug,
          "Tabbed",
          "tabbed@example.com",
        );
        const response = await adminGet(
          `/admin/attendees/${attendee.id}/nonsense`,
        );
        expect(response.status).toBe(404);
      });

      test("an unknown attendee id 404s on every tab", async () => {
        await createTestListing({ maxAttendees: 10 });
        expect((await adminGet("/admin/attendees/999999")).status).toBe(404);
        expect((await adminGet("/admin/attendees/999999/edit")).status).toBe(
          404,
        );
      });

      test("the banner notes are visible on non-overview tabs too", async () => {
        const listing = await createTestListing({ maxAttendees: 10 });
        const attendee = await createTestAttendee(
          listing.id,
          listing.slug,
          "Noted",
          "noted@example.com",
        );
        const { createOwnerNote } = await import("#shared/db/system-notes.ts");
        await createOwnerNote(attendee.id, "Allergic to peanuts");
        const html = await (
          await adminGet(`/admin/attendees/${attendee.id}/activity`)
        ).text();
        expect(html).toContain("Allergic to peanuts");
        // The strip marks the active tab for the viewer.
        expect(html).toContain(
          `aria-current="page" class="active" href="/admin/attendees/${attendee.id}/activity"`,
        );
      });
    });
  },
);
