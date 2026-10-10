// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { settings } from "#db/settings.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookingPageHtml, makeParent } from "#test-utils/parents.ts";

// jscpd:ignore-end

describeWithEnv(
  "server > parents gate > render: selector & price visibility",
  { db: true, triggers: true },
  () => {
    test("a Square free parent with a paid child renders a present-but-non-required email", async () => {
      // Square requires an email for paid orders, but the page itself is free
      // (only a POSSIBLE child is paid); the email field must be present so a
      // buyer who picks the paid child can fill it, yet non-required so picking
      // the free child / leaving the parent at zero doesn't block submit.
      // Server-side validation enforces it when the folded order is paid.
      await settings.update.paymentProvider("square");
      try {
        const { parent } = await makeParent({
          children: [{ unitPrice: 0 }, { unitPrice: 1500 }],
          parent: { fields: "" },
        });

        const html = await bookingPageHtml(parent.slug);
        expect(html).toContain('name="email"');
        expect(html).not.toMatch(/name="email"[^>]*\srequired/);
      } finally {
        await settings.update.setPaymentProviderNone();
      }
    });

    test("a child's stricter contact field is rendered (non-required) on the parent page", async () => {
      // Parent collects only email; the child also requires phone. The buyer must
      // SEE the phone field to fill it, but it renders non-required (server-side
      // validation is authoritative for the selected child).
      const { parent } = await makeParent({
        children: [{ fields: "email,phone" }],
        parent: { fields: "email" },
      });

      const html = await bookingPageHtml(parent.slug);
      expect(html).toContain('name="phone"');
      // The child-only field is present but not HTML-required.
      expect(html).not.toMatch(/name="phone"[^>]*\srequired/);
    });
  },
);
