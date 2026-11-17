/**
 * Which form the new-listing route opens, and which template it remembers.
 *
 * `/admin/listing/new` shows a picker card page until the operator names a
 * template. A rejected create has to re-open the same shaped form, so the page
 * carries the template in a hidden `templateId` field — either the one the
 * operator submitted, or one worked out from what they typed.
 */

import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { settings } from "#db/settings.ts";
import { t } from "#i18n";
import { describeWithEnv } from "#test-utils/db.ts";
import { buildCreateListingForm } from "#test-utils/db-helpers/listing-forms.ts";
import { testListingInput } from "#test-utils/factories.ts";
import { adminGet, adminMultipartPost } from "#test-utils/session.ts";
import {
  featureSetting,
  setupStripe,
  withSetting,
} from "#test-utils/settings.ts";

const PICKER_HEADING = "Choose a listing type";
const FORM_HEADING = "<h1>Add Listing</h1>";

const pageAt = async (path: string): Promise<string> =>
  await (await adminGet(path)).text();

/** The page is the type picker, not a form. */
const expectPicker = (html: string): void => {
  assertStringIncludes(html, PICKER_HEADING);
  assert(!html.includes(FORM_HEADING));
};

/** The template the page will carry back into a re-submitted create. */
const carriedTemplate = (html: string): string | null =>
  /name="templateId"[^>]*value="([^"]*)"/.exec(html)?.[1] ?? null;

/** A create that always fails validation, so the error page renders. The blank
 * name is what fails; every other field is the shape under test. */
const rejectedCreate = async (
  shape: Parameters<typeof testListingInput>[0],
  extra: Record<string, string> = {},
): Promise<string> => {
  const { response } = await adminMultipartPost("/admin/listing", {
    ...buildCreateListingForm(testListingInput({ ...shape, name: "" })),
    ...extra,
  });
  expect(response.status).toBe(400);
  return await response.text();
};

describeWithEnv("opening the new listing form", { db: true }, () => {
  test("offers the type picker when no template is named", async () => {
    expectPicker(await pageAt("/admin/listing/new"));
  });

  test("opens the form for a named template and remembers it", async () => {
    const html = await pageAt("/admin/listing/new?template=one-off-event");

    assertStringIncludes(html, FORM_HEADING);
    assert(!html.includes(PICKER_HEADING));
    expect(carriedTemplate(html)).toBe("one-off-event");

    // The physical product card remembers its template too, and its seed
    // checks the email + delivery-address boxes.
    const physical = await pageAt(
      "/admin/listing/new?template=physical-product",
    );
    expect(carriedTemplate(physical)).toBe("physical-product");
    assertStringIncludes(physical, 'value="address" checked');
  });

  test("treats an unknown template as the custom form", async () => {
    const html = await pageAt("/admin/listing/new?template=custom");

    assertStringIncludes(html, FORM_HEADING);
    expect(carriedTemplate(html)).toBe("custom");
  });

  test("sends a logistics template back to the picker while the feature is off", async () => {
    expectPicker(await pageAt("/admin/listing/new?template=hireable-item"));
  });

  test("opens the same logistics template once the feature is on", async () => {
    settings.setForTest(featureSetting("logistics"));
    try {
      const html = await pageAt("/admin/listing/new?template=hireable-item");

      assertStringIncludes(html, FORM_HEADING);
      expect(carriedTemplate(html)).toBe("hireable-item");
    } finally {
      settings.clearTestOverride("enabled_features");
    }
  });

  test("picker shows hireable as a live card once the feature is on", async () => {
    settings.setForTest(featureSetting("logistics"));
    try {
      const html = await pageAt("/admin/listing/new");

      assertStringIncludes(html, PICKER_HEADING);
      assertStringIncludes(
        html,
        'href="/admin/listing/new?template=hireable-item"',
      );
      // A live card, not the disabled placeholder.
      assert(!html.includes(t("listings_table.template_requires_logistics")));
    } finally {
      settings.clearTestOverride("enabled_features");
    }
  });
});

describeWithEnv("the subscription card", { db: true }, () => {
  const FORM_PATH = "/admin/listing/new?template=subscription";

  /** The picker's subscription card: a live link, or disabled with the
   *  sentence that says what to turn on. Never both. */
  const subscriptionCard = async (): Promise<"live" | "disabled"> => {
    const picker = await pageAt("/admin/listing/new");
    const live = picker.includes(`href="${FORM_PATH}"`);
    expect(
      picker.includes(t("listings_table.template_requires_subscriptions")),
    ).toBe(!live);
    return live ? "live" : "disabled";
  };

  test("is disabled, and its form refused, while the feature is off", async () => {
    await setupStripe();
    expect(await subscriptionCard()).toBe("disabled");
    expectPicker(await pageAt(FORM_PATH));
  });

  test("stays disabled with the feature on until Stripe takes payments", () =>
    withSetting(featureSetting("subscriptions"), async () => {
      expect(await subscriptionCard()).toBe("disabled");
    }));

  test("opens a monthly plan once the feature is on and Stripe is set up", async () => {
    await setupStripe();
    await withSetting(featureSetting("subscriptions"), async () => {
      expect(await subscriptionCard()).toBe("live");
      const form = await pageAt(FORM_PATH);
      expect(carriedTemplate(form)).toBe("subscription");
      assertStringIncludes(form, 'value="month" selected');
    });
  });
});

describeWithEnv("a rejected create keeps its template", { db: true }, () => {
  test("keeps the template the operator submitted", async () => {
    // The submitted shape infers one-off-event, so a page that re-derived the
    // template instead of reading the submitted one would say so.
    const html = await rejectedCreate(
      { date: "2026-09-01T10:00", listingType: "standard" },
      { templateId: "weekly-event" },
    );

    expect(carriedTemplate(html)).toBe("weekly-event");
  });

  test("works the template out from a dated one-off shape", async () => {
    const html = await rejectedCreate({
      date: "2026-09-01T10:00",
      listingType: "standard",
    });

    expect(carriedTemplate(html)).toBe("one-off-event");
  });

  test("works it out from a daily shape with no date", async () => {
    const html = await rejectedCreate({ listingType: "daily" });

    expect(carriedTemplate(html)).toBe("weekly-event");
  });

  test("works it out from a no-check-in shape", async () => {
    const html = await rejectedCreate({
      listingType: "standard",
      purchaseOnly: true,
    });

    expect(carriedTemplate(html)).toBe("online-digital");
  });

  test("works it out from a shape that also uses logistics", async () => {
    settings.setForTest(featureSetting("logistics"));
    try {
      const html = await rejectedCreate({
        listingType: "standard",
        purchaseOnly: true,
        usesLogistics: true,
      });

      expect(carriedTemplate(html)).toBe("hireable-item");
    } finally {
      settings.clearTestOverride("enabled_features");
    }
  });

  test("carries no template when the shape matches none", async () => {
    // Standard, no date, check-in wanted, no logistics is the Custom card's
    // shape, which no template signature claims.
    const html = await rejectedCreate({ listingType: "standard" });

    expect(carriedTemplate(html)).toBe(null);
  });
});
