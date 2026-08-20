import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { Liquid } from "liquidjs";
import { ALL_SETTINGS_KEYS, settings } from "#db/settings.ts";
import { renderEmailContent } from "#shared/email-renderer.ts";
import { makeTestEntry as makeEntry } from "#test-utils/factories.ts";
import {
  buildTestData,
  describeEmailRenderer,
  renderConfirmation,
} from "./test-helpers.ts";

describeEmailRenderer(() => {
  describe("renderEmailContent", () => {
    test("uses default templates when no custom templates are set", async () => {
      const { result } = await renderConfirmation();

      expect(result.subject).toContain("Test Listing");
      expect(result.html).toContain("Test Listing");
      expect(result.html).toContain("https://example.com/t/ABC");
      expect(result.text).toContain("Test Listing");
      expect(result.text).toContain("https://example.com/t/ABC");
    });

    test("uses custom templates when set", async () => {
      await settings.update.email.template(
        "confirmation",
        "subject",
        "Custom: {{ listing_names }}",
      );
      await settings.update.email.template(
        "confirmation",
        "html",
        "<b>Custom HTML for {{ attendee.name }}</b>",
      );
      await settings.update.email.template(
        "confirmation",
        "text",
        "Custom text for {{ attendee.name }}",
      );
      const { result } = await renderConfirmation();

      expect(result.subject).toBe("Custom: Test Listing");
      expect(result.html).toBe("<b>Custom HTML for Jane Doe</b>");
      expect(result.text).toBe("Custom text for Jane Doe");
    });

    test("falls back to default on custom template render error", async () => {
      await settings.update.email.template(
        "confirmation",
        "subject",
        "{{ invalid | nonexistent_filter }}",
      );
      const { result } = await renderConfirmation();

      expect(result.subject).toContain("Test Listing");
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toBeInstanceOf(Error);
    });

    test("renders admin notification defaults correctly", async () => {
      const data = await buildTestData([makeEntry()]);
      const result = await renderEmailContent("admin", data);

      expect(result.subject).toContain("Jane Doe");
      expect(result.subject).toContain("Test Listing");
      expect(result.html).toContain("Jane Doe");
      expect(result.text).toContain("Name: Jane Doe");
    });

    test("renders admin notification with contact details", async () => {
      const data = await buildTestData([
        makeEntry(
          {},
          {
            address: "123 Main St",
            phone: "555-1234",
            special_instructions: "Wheelchair",
          },
        ),
      ]);
      const result = await renderEmailContent("admin", data);

      expect(result.text).toContain("Phone: 555-1234");
      expect(result.text).toContain("Address: 123 Main St");
      expect(result.text).toContain("Notes: Wheelchair");
    });

    test("omits empty contact fields in admin notification", async () => {
      const data = await buildTestData([
        makeEntry({}, { address: "", phone: "", special_instructions: "" }),
      ]);
      const result = await renderEmailContent("admin", data);

      expect(result.text).not.toContain("Phone:");
      expect(result.text).not.toContain("Address:");
      expect(result.text).not.toContain("Notes:");
    });

    test("renders paid listing with currency in confirmation", async () => {
      const data = await buildTestData([
        makeEntry({ unit_price: 1000 }, { price_paid: "2000", quantity: 2 }),
      ]);
      const result = await renderEmailContent("confirmation", data);

      expect(result.html).toContain("£20");
      expect(result.text).toContain("£20");
    });

    test("shows the amount owed when a balance is outstanding", async () => {
      const data = await buildTestData([
        makeEntry(
          { unit_price: 1000 },
          { price_paid: "0", remaining_balance: 2000 },
        ),
      ]);
      const confirmation = await renderEmailContent("confirmation", data);
      const admin = await renderEmailContent("admin", data);

      expect(confirmation.html).toContain("Amount owed");
      expect(confirmation.html).toContain("£20");
      expect(confirmation.text).toContain("Amount owed: £20");
      expect(admin.html).toContain("Amount owed");
    });

    test("omits the amount owed when the booking is fully paid", async () => {
      const data = await buildTestData([
        makeEntry(
          { unit_price: 1000 },
          { price_paid: "1000", remaining_balance: 0 },
        ),
      ]);
      const result = await renderEmailContent("confirmation", data);

      expect(result.html).not.toContain("Amount owed");
      expect(result.text).not.toContain("Amount owed");
    });

    test("shows date when attendee has date", async () => {
      const data = await buildTestData([makeEntry({}, { date: "2026-07-15" })]);
      const result = await renderEmailContent("confirmation", data);

      expect(result.html).toContain("2026-07-15");
      expect(result.text).toContain("2026-07-15");
    });

    test("uses mix of custom and default parts", async () => {
      await settings.update.email.template(
        "confirmation",
        "subject",
        "Custom Subject: {{ listing_names }}",
      );
      const { result } = await renderConfirmation();

      expect(result.subject).toBe("Custom Subject: Test Listing");
      expect(result.html).toContain("Thanks for registering!");
      expect(result.text).toContain("Thanks for registering!");
    });

    test("collects non-Error thrown values", async () => {
      await settings.update.email.template(
        "confirmation",
        "subject",
        "Custom {{ listing_names }}",
      );
      settings.invalidateCache();
      await settings.loadKeys(ALL_SETTINGS_KEYS);

      let callCount = 0;
      const original = Liquid.prototype.parseAndRender;
      const parseAndRenderStub = stub(
        Liquid.prototype,
        "parseAndRender",
        function (
          this: InstanceType<typeof Liquid>,
          ...args: Parameters<typeof original>
        ) {
          if (callCount++ === 0) throw "string error value";
          return original.apply(this, args);
        },
      );
      try {
        const data = await buildTestData([makeEntry()]);
        const result = await renderEmailContent("confirmation", data);

        expect(result.errors).toEqual(["string error value"]);
      } finally {
        parseAndRenderStub.restore();
      }
    });

    test("resets to defaults after clearing custom template", async () => {
      await settings.update.email.template(
        "confirmation",
        "subject",
        "Custom Subject",
      );
      settings.invalidateCache();
      await settings.loadKeys(ALL_SETTINGS_KEYS);

      await settings.update.email.template("confirmation", "subject", "");
      const { result } = await renderConfirmation();

      expect(result.subject).toContain("Test Listing");
    });
  });
});
