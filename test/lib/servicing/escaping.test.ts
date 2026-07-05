/**
 * Servicing §0 — listing-name escaping on the servicing form.
 *
 * Listing names are operator-controlled but still untrusted HTML. The servicing
 * create/edit page renders them into raw table rows and `<option>` labels;
 * those interpolations must be HTML-escaped so a name like
 * `<script>alert(1)</script>` reads as text, not executable markup — the same
 * escaping JSX applies automatically elsewhere.
 */
// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  createDailyTestListing,
  createServicingHold,
  describeWithEnv,
  renderAdminPage,
} from "#test-utils";

// jscpd:ignore-end

const XSS_NAME = "<script>alert(1)</script>";
const ESCAPED_NAME = "&lt;script&gt;alert(1)&lt;/script&gt;";

describeWithEnv(
  "servicing §0 — listing names are escaped on the servicing form",
  { db: true },
  () => {
    test("the create page escapes the listing name in the booking table", async () => {
      await createDailyTestListing({ maxAttendees: 5, name: XSS_NAME });
      const body = await renderAdminPage("/admin/servicing/new");
      expect(body).toContain(ESCAPED_NAME);
      expect(body).not.toContain(XSS_NAME);
    });

    test("the edit page escapes the listing name in the booking table and the cost <option>", async () => {
      const listing = await createDailyTestListing({
        maxAttendees: 5,
        name: XSS_NAME,
      });
      const { id } = await createServicingHold({
        listing: { maxAttendees: 5, name: XSS_NAME },
        name: "Boiler Service",
      });
      const body = await renderAdminPage(`/admin/servicing/${id}`);
      // Booking table row + cost-form <option> label both carry the escaped
      // name; the raw script tag never appears verbatim.
      const occurrences = body.split(ESCAPED_NAME).length - 1;
      expect(occurrences).toBeGreaterThanOrEqual(2);
      expect(body).not.toContain(XSS_NAME);
      // The cost form's option targets the listing by its id, and the label is
      // the escaped name (not the raw markup).
      expect(body).toContain(
        `<option value="${listing.id}">${ESCAPED_NAME}</option>`,
      );
    });
  },
);
