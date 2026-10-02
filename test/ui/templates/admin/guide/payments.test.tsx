import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import { formatCurrency } from "#shared/currency.ts";
import {
  type GuideSection,
  renderGuideSections,
} from "#templates/admin/guide/components.tsx";
import {
  durationWords,
  paymentsSections,
} from "#templates/admin/guide/payments.tsx";
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
      { id: "holidays", titleKey: "daily_listings_and_holidays" },
    ]);
  });

  test("explains the booking fee with worked example prices", () => {
    const html = String(renderGuideSections([sectionByTitle("payments")]));
    expect(html).toContain(t("guide.q.what_is_booking_fee"));
    // The full phrases, not bare amounts: "£10" alone also matches inside
    // "£10.20", so a mutated example price could hide behind the other one.
    expect(html).toContain(`on a ${formatCurrency(1000)} ticket`);
    expect(html).toContain(`pays ${formatCurrency(1020)} in total`);
    expect(html).toContain(
      '<a href="/admin/settings">Settings</a> under <strong>Booking Fee</strong>',
    );
  });

  test("states the checkout window the site actually uses", () => {
    const html = String(renderGuideSections([sectionByTitle("payments")]));
    expect(html).toContain(t("guide.q.checkout_window"));
    // The default window is 60 minutes, so the copy must read "an hour", not
    // a hardcoded "about one hour" that outlives a site's own setting.
    expect(html).toContain("for an hour after it starts");
    expect(html).toContain("A SumUp checkout always closes after 30 minutes.");
  });

  test("names the booking duration field the way the listing form does", () => {
    const html = String(
      renderGuideSections([sectionByTitle("daily_listings_and_holidays")]),
    );
    expect(html).toContain(t("guide.q.booking_duration_field"));
    expect(html).toContain(
      "For daily listings, <strong>Booking duration (days)</strong>",
    );
    expect(html).toContain(`up to ${MAX_DURATION_DAYS} days`);
  });
});

describe("checkout window in words", () => {
  test("reads whole hours in hours", () => {
    expect(durationWords(60)).toBe("an hour");
    expect(durationWords(120)).toBe("2 hours");
    expect(durationWords(1440)).toBe("24 hours");
  });

  test("reads every other window in minutes", () => {
    expect(durationWords(30)).toBe("30 minutes");
    expect(durationWords(45)).toBe("45 minutes");
    expect(durationWords(90)).toBe("90 minutes");
  });
});
