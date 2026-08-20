/**
 * Which form the new-listing route opens, and which template it remembers.
 *
 * `/admin/listing/new` shows a picker card page until the operator names a
 * template. A rejected create has to re-open the same shaped form, so the page
 * carries the template in a hidden `template_id` field — either the one the
 * operator submitted, or one worked out from what they typed.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { settings } from "#db/settings.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { buildCreateListingForm } from "#test-utils/db-helpers/listing-forms.ts";
import { testListingInput } from "#test-utils/factories.ts";
import { adminGet, adminMultipartPost } from "#test-utils/session.ts";
import { featureSetting } from "#test-utils/settings.ts";

const PICKER_HEADING = "Choose a listing type";
const FORM_HEADING = "<h1>Add Listing</h1>";

/** The template the page will carry back into a re-submitted create. */
const carriedTemplate = (html: string): string | null =>
  /name="template_id"[^>]*value="([^"]*)"/.exec(html)?.[1] ?? null;

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
    const html = await (await adminGet("/admin/listing/new")).text();

    expect(html).toContain(PICKER_HEADING);
    expect(html).not.toContain(FORM_HEADING);
  });

  test("opens the form for a named template and remembers it", async () => {
    const html = await (
      await adminGet("/admin/listing/new?template=one-off-event")
    ).text();

    expect(html).toContain(FORM_HEADING);
    expect(html).not.toContain(PICKER_HEADING);
    expect(carriedTemplate(html)).toBe("one-off-event");
  });

  test("treats an unknown template as the custom form", async () => {
    const html = await (
      await adminGet("/admin/listing/new?template=custom")
    ).text();

    expect(html).toContain(FORM_HEADING);
    expect(carriedTemplate(html)).toBe("custom");
  });

  test("sends a logistics template back to the picker while the feature is off", async () => {
    const html = await (
      await adminGet("/admin/listing/new?template=hireable-item")
    ).text();

    expect(html).toContain(PICKER_HEADING);
    expect(html).not.toContain(FORM_HEADING);
  });

  test("opens the same logistics template once the feature is on", async () => {
    settings.setForTest(featureSetting("logistics"));
    try {
      const html = await (
        await adminGet("/admin/listing/new?template=hireable-item")
      ).text();

      expect(html).toContain(FORM_HEADING);
      expect(carriedTemplate(html)).toBe("hireable-item");
    } finally {
      settings.clearTestOverride("enabled_features");
    }
  });
});

describeWithEnv("a rejected create keeps its template", { db: true }, () => {
  test("keeps the template the operator submitted", async () => {
    // The submitted shape infers one-off-event, so a page that re-derived the
    // template instead of reading the submitted one would say so.
    const html = await rejectedCreate(
      { date: "2026-09-01T10:00", listingType: "standard" },
      { template_id: "weekly-event" },
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
