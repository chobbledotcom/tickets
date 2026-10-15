import { assert, assertStringIncludes } from "@std/assert";
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

      assertStringIncludes(result.subject, "Test Listing");
      assertStringIncludes(result.html, "Test Listing");
      assertStringIncludes(result.html, "https://example.com/t/ABC");
      assertStringIncludes(result.text, "Test Listing");
      assertStringIncludes(result.text, "https://example.com/t/ABC");
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

      assertStringIncludes(result.subject, "Test Listing");
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toBeInstanceOf(Error);
    });

    test("renders admin notification defaults correctly", async () => {
      const data = await buildTestData([makeEntry()]);
      const result = await renderEmailContent("admin", data);

      assertStringIncludes(result.subject, "Jane Doe");
      assertStringIncludes(result.subject, "Test Listing");
      assertStringIncludes(result.html, "Jane Doe");
      assertStringIncludes(result.text, "Name: Jane Doe");
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

      assertStringIncludes(result.text, "Phone: 555-1234");
      assertStringIncludes(result.text, "Address: 123 Main St");
      assertStringIncludes(result.text, "Notes: Wheelchair");
    });

    test("escapes HTML and script-like values in booking fields", async () => {
      const data = await buildTestData([
        makeEntry(
          {},
          {
            address: `7 <b>Elm</b> St & "Sign"`,
            email: "jane@example.com",
            name: `Jane <script>alert("x")</script> Doe`,
            phone: "<img src=x onerror=alert(1)>",
            special_instructions: "<iframe></iframe>",
          },
        ),
      ]);
      const admin = await renderEmailContent("admin", data);

      const { html } = admin;
      assert(
        !html.includes("<script>"),
        "the value should not contain the searched item",
      );
      assert(
        !html.includes("<img"),
        "the value should not contain the searched item",
      );
      assert(
        !html.includes("<iframe>"),
        "the value should not contain the searched item",
      );
      assertStringIncludes(
        html,
        "Jane &lt;script&gt;alert(&#34;x&#34;)&lt;/script&gt; Doe",
      );
      assertStringIncludes(html, "&lt;img src=x onerror=alert(1)&gt;");
      assertStringIncludes(
        html,
        "7 &lt;b&gt;Elm&lt;/b&gt; St &amp; &#34;Sign&#34;",
      );
      assertStringIncludes(html, "&lt;iframe&gt;&lt;/iframe&gt;");
      assertStringIncludes(
        admin.subject,
        `Jane <script>alert("x")</script> Doe`,
      );
      assertStringIncludes(
        admin.text,
        `Name: Jane <script>alert("x")</script> Doe`,
      );
    });

    test("escapes booking fields in a custom HTML template", async () => {
      await settings.update.email.template(
        "admin",
        "html",
        "Booked for {{ attendee.name }} ({{ attendee.phone }})",
      );
      const data = await buildTestData([
        makeEntry({}, { name: "<b>Hostile</b>", phone: "<i>555</i>" }),
      ]);
      const result = await renderEmailContent("admin", data);

      expect(result.html).toBe(
        "Booked for &lt;b&gt;Hostile&lt;/b&gt; (&lt;i&gt;555&lt;/i&gt;)",
      );
    });

    test("falls back to the default template when a custom HTML template uses raw", async () => {
      await settings.update.email.template(
        "admin",
        "html",
        "{{ attendee.name | raw }}",
      );
      const data = await buildTestData([
        makeEntry({}, { name: "<b>Hostile</b>" }),
      ]);
      const result = await renderEmailContent("admin", data);

      assert(
        !result.html.includes("<b>Hostile</b>"),
        "the value should not contain the searched item",
      );
      assertStringIncludes(result.html, "&lt;b&gt;Hostile&lt;/b&gt;");
      expect(result.errors).toHaveLength(1);
    });

    test("omits empty contact fields in admin notification", async () => {
      const data = await buildTestData([
        makeEntry({}, { address: "", phone: "", special_instructions: "" }),
      ]);
      const result = await renderEmailContent("admin", data);

      assert(
        !result.text.includes("Phone:"),
        "the value should not contain the searched item",
      );
      assert(
        !result.text.includes("Address:"),
        "the value should not contain the searched item",
      );
      assert(
        !result.text.includes("Notes:"),
        "the value should not contain the searched item",
      );
    });

    test("renders paid listing with currency in confirmation", async () => {
      const data = await buildTestData([
        makeEntry({ unit_price: 1000 }, { price_paid: "2000", quantity: 2 }),
      ]);
      const result = await renderEmailContent("confirmation", data);

      assertStringIncludes(result.html, "£20");
      assertStringIncludes(result.text, "£20");
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

      assertStringIncludes(confirmation.html, "Amount owed");
      assertStringIncludes(confirmation.html, "£20");
      assertStringIncludes(confirmation.text, "Amount owed: £20");
      assertStringIncludes(admin.html, "Amount owed");
    });

    test("omits the amount owed when the booking is fully paid", async () => {
      const data = await buildTestData([
        makeEntry(
          { unit_price: 1000 },
          { price_paid: "1000", remaining_balance: 0 },
        ),
      ]);
      const result = await renderEmailContent("confirmation", data);

      assert(
        !result.html.includes("Amount owed"),
        "the value should not contain the searched item",
      );
      assert(
        !result.text.includes("Amount owed"),
        "the value should not contain the searched item",
      );
    });

    test("shows date when attendee has date", async () => {
      const data = await buildTestData([makeEntry({}, { date: "2026-07-15" })]);
      const result = await renderEmailContent("confirmation", data);

      assertStringIncludes(result.html, "2026-07-15");
      assertStringIncludes(result.text, "2026-07-15");
    });

    test("uses mix of custom and default parts", async () => {
      await settings.update.email.template(
        "confirmation",
        "subject",
        "Custom Subject: {{ listing_names }}",
      );
      const { result } = await renderConfirmation();

      expect(result.subject).toBe("Custom Subject: Test Listing");
      assertStringIncludes(result.html, "Thanks for registering!");
      assertStringIncludes(result.text, "Thanks for registering!");
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

      assertStringIncludes(result.subject, "Test Listing");
    });
  });
});
