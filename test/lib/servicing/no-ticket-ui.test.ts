/**
 * Servicing §6 — no ticket / QR interface.
 *
 * The servicing create/edit pages are stripped-down variants of the attendee
 * form: no QR image, no ticket link, no wallet buttons (edit page), and no
 * contact / payment inputs (create page). A servicing hold has nothing to show
 * a customer, so none of the ticket surfaces may render.
 *
 * Implementation contract (test-first):
 *   - Servicing routes live at `/admin/servicing/new` (create) and
 *     `/admin/servicing/:id` (edit), rendering the servicing field schema from §0
 *     (`buildServicingFieldSchema`) and the hidden indicator, but NOT the
 *     attendee ticket/QR/wallet panel nor the contact/payment fields.
 */
// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  createServicingHold,
  createTestAttendeeDirect,
  createTestListing,
  describeWithEnv,
  renderAdminPage,
} from "#test-utils";

// jscpd:ignore-end

const SERVICING_EDIT_PANEL_MARKERS = [
  /href="https?:[^"]*\/t\/[^"]+"/,
  /\/t\/[^/]+\/svg/,
  /\.pkpass\b/,
  /google\.com\/wallet/i,
];

const SERVICING_CREATE_CONTACT_FIELDS = [
  'name="email"',
  'name="phone"',
  'name="address"',
  'name="special_instructions"',
  'name="status_id"',
  'name="remaining_balance"',
];

describeWithEnv(
  "servicing §6 — no ticket / QR / wallet interface",
  { db: true },
  () => {
    test("the servicing edit page renders no QR image, ticket link, or wallet buttons", async () => {
      const { id } = await createServicingHold({
        listing: { name: "Room A" },
      });
      const body = await renderAdminPage(`/admin/servicing/${id}`);
      for (const marker of SERVICING_EDIT_PANEL_MARKERS) {
        expect(marker.test(body)).toBe(false);
      }
    });

    test("control: the attendee edit page DOES render a ticket link (proves the assertion bites)", async () => {
      const listing = await createTestListing({
        maxAttendees: 10,
        name: "Room B",
      });
      const { attendee } = await createTestAttendeeDirect(
        listing.id,
        "Real Customer",
        "real@example.com",
      );
      const body = await renderAdminPage(`/admin/attendees/${attendee.id}`);
      expect(/href="https?:[^"]*\/t\/[^"]+"/.test(body)).toBe(true);
    });

    test("the servicing create form omits contact and payment fields", async () => {
      await createTestListing({ maxAttendees: 10, name: "Servicing Target" });
      const body = await renderAdminPage("/admin/servicing/new");
      for (const field of SERVICING_CREATE_CONTACT_FIELDS) {
        expect(body).not.toContain(field);
      }
      expect(body).toContain('name="name"');
      expect(body).toMatch(/day_count|start_date/);
    });
  },
);
