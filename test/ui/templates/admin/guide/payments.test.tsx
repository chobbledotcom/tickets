import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import { formatCurrency } from "#shared/currency.ts";
import {
  type GuideSection,
  renderGuideSections,
} from "#templates/admin/guide/components.tsx";
import { paymentsSections } from "#templates/admin/guide/payments.tsx";
import { expectIncludesAll } from "#test-utils/assertions.ts";
import { MAX_DURATION_DAYS } from "#types";

const sections = paymentsSections();

const sectionByTitle = (titleKey: string): GuideSection => {
  const section = sections.find((entry) => entry.titleKey === titleKey);
  if (section === undefined) throw new Error(`No ${titleKey} guide section`);
  return section;
};

describe("payments guide schema", () => {
  test("keeps every payments section in its intended order", () => {
    expect(sections.map(({ id, titleKey }) => ({ id, titleKey }))).toEqual([
      { id: undefined, titleKey: "payments" },
      { id: "payment-setup", titleKey: "payment_setup" },
      { id: "refunds", titleKey: "refunds" },
      { id: "ledger", titleKey: "ledger" },
      { id: "invoices", titleKey: "invoices" },
      { id: "holidays", titleKey: "daily_listings_and_holidays" },
    ]);
  });

  test("explains the booking fee with worked example prices", () => {
    const html = String(renderGuideSections([sectionByTitle("payments")]));
    expectIncludesAll(html, [
      t("guide.q.what_is_booking_fee"),
      // The full phrases, not bare amounts: "£10" alone also matches inside
      // "£10.20", so a mutated example price could hide behind the other one.
      `on a ${formatCurrency(1000)} ticket`,
      `pays ${formatCurrency(1020)} in total`,
      '<a href="/admin/settings">Settings</a> under <strong>Booking Fee</strong>',
    ]);
  });

  test("states the checkout window the site actually uses", () => {
    const html = String(renderGuideSections([sectionByTitle("payments")]));
    expectIncludesAll(html, [
      t("guide.q.checkout_window"),
      // The default window is 60 minutes, so the copy must read "an hour", not
      // a hardcoded "about one hour" that outlives a site's own setting.
      "for an hour after it starts",
      "A SumUp checkout always closes after 30 minutes.",
    ]);
  });

  test("names the booking duration field the way the listing form does", () => {
    const html = String(
      renderGuideSections([sectionByTitle("daily_listings_and_holidays")]),
    );
    expectIncludesAll(html, [
      t("guide.q.booking_duration_field"),
      "For daily listings, <strong>Booking duration (days)</strong>",
      `up to ${MAX_DURATION_DAYS} days`,
    ]);
  });

  test("names the invoice preview button the invoice page shows", () => {
    const html = String(renderGuideSections([sectionByTitle("invoices")]));
    expectIncludesAll(html, [
      t("guide.q.invoices_how_they_work"),
      "<strong>Update preview</strong>",
    ]);
  });
});
