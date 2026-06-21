import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { settings } from "#shared/db/settings.ts";
import {
  adminFormPost,
  describeWithEnv,
  expectFlashRedirect,
} from "#test-utils";

describeWithEnv("server (admin settings: column order)", { db: true }, () => {
  describe("POST /admin/settings/listing-column-order", () => {
    const formUrl =
      "/admin/settings-advanced?form=settings-listing-column-order#settings-listing-column-order";

    test("saves valid listing column order", async () => {
      const { response } = await adminFormPost(
        "/admin/settings/listing-column-order",
        { column_order: "{{name}}, {{status}}" },
      );
      await expectFlashRedirect(
        formUrl,
        "Listing column order updated",
      )(response);
      expect(settings.listingColumnOrder).toBe("{{name}}, {{status}}");
    });

    test("rejects invalid column name", async () => {
      const { response } = await adminFormPost(
        "/admin/settings/listing-column-order",
        { column_order: "{{invalid}}" },
      );
      await expectFlashRedirect(formUrl, undefined, false)(response);
      const msg = decodeURIComponent(response.headers.get("set-cookie") ?? "");
      expect(msg).toContain("invalid");
      expect(msg).toContain("Available columns");
    });

    test("clears to default when empty", async () => {
      await settings.update.listingColumnOrder("{{name}}");
      const { response } = await adminFormPost(
        "/admin/settings/listing-column-order",
        { column_order: "" },
      );
      await expectFlashRedirect(
        formUrl,
        "Listing column order updated",
      )(response);
      expect(settings.listingColumnOrder).toBe("");
    });
  });

  describe("POST /admin/settings/attendee-column-order", () => {
    const formUrl =
      "/admin/settings-advanced?form=settings-attendee-column-order#settings-attendee-column-order";

    test("saves valid attendee column order", async () => {
      const { response } = await adminFormPost(
        "/admin/settings/attendee-column-order",
        { column_order: "{{name}}, {{qty}}, {{ticket}}" },
      );
      await expectFlashRedirect(
        formUrl,
        "Attendee column order updated",
      )(response);
      expect(settings.attendeeColumnOrder).toBe(
        "{{name}}, {{qty}}, {{ticket}}",
      );
    });

    test("rejects invalid column name", async () => {
      const { response } = await adminFormPost(
        "/admin/settings/attendee-column-order",
        { column_order: "{{bogus}}" },
      );
      await expectFlashRedirect(formUrl, undefined, false)(response);
      const msg = decodeURIComponent(response.headers.get("set-cookie") ?? "");
      expect(msg).toContain("bogus");
      expect(msg).toContain("Available columns");
    });

    test("clears to default when empty", async () => {
      await settings.update.attendeeColumnOrder("{{name}}");
      const { response } = await adminFormPost(
        "/admin/settings/attendee-column-order",
        { column_order: "" },
      );
      await expectFlashRedirect(
        formUrl,
        "Attendee column order updated",
      )(response);
      expect(settings.attendeeColumnOrder).toBe("");
    });
  });
});
