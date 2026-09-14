/** Promo-code field rendering on the booking form: when the box shows at
 * all, and which value it holds — a submitted value (including an explicitly
 * cleared one) always wins over the `?promo=` URL pre-fill. */

import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { FormParams } from "#shared/form-data.ts";
import {
  clearSavedFormData,
  setSavedFormData,
} from "#shared/forms/saved-data.ts";
import {
  registerPublicTemplateHooks,
  singleListingPageHtml,
} from "#test/ui/templates/helpers.ts";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";

describe("the promo-code field", () => {
  beforeAll(setupAdminPageTest);
  registerPublicTemplateHooks();

  test("omits the field when promo codes are disabled", () => {
    const html = singleListingPageHtml();
    expect(html).not.toContain('name="promo_code"');
  });

  test("restores the submitted promo code", () => {
    setSavedFormData(new FormParams({ promo_code: "SAVE20" }));
    try {
      const html = singleListingPageHtml({ promoCodesEnabled: true });
      expect(html).toContain('<div class="promo-code"><label>Promo code');
      expect(html).toContain(
        'name="promo_code" placeholder="Optional" type="text" value="SAVE20"',
      );
    } finally {
      clearSavedFormData();
    }
  });

  test("fills the box from the ?promo= prefill", () => {
    const html = singleListingPageHtml({
      prefill: { listings: new Map(), promo: "summer25" },
      promoCodesEnabled: true,
    });
    expect(html).toContain(
      'name="promo_code" placeholder="Optional" type="text" value="summer25"',
    );
  });

  test("restores the submitted promo code before the ?promo= prefill", () => {
    setSavedFormData(new FormParams({ promo_code: "TYPED99" }));
    try {
      const html = singleListingPageHtml({
        prefill: { listings: new Map(), promo: "summer25" },
        promoCodesEnabled: true,
      });
      expect(html).toContain(
        'name="promo_code" placeholder="Optional" type="text" value="TYPED99"',
      );
      expect(html).not.toContain('value="summer25"');
    } finally {
      clearSavedFormData();
    }
  });

  test("keeps an explicitly cleared promo code empty", () => {
    // A buyer who deleted the code and failed validation submitted an empty
    // field: that choice wins, so the URL code must not come back.
    setSavedFormData(new FormParams({ promo_code: "" }));
    try {
      const html = singleListingPageHtml({
        prefill: { listings: new Map(), promo: "summer25" },
        promoCodesEnabled: true,
      });
      expect(html).toContain(
        'name="promo_code" placeholder="Optional" type="text" value=""',
      );
      expect(html).not.toContain('value="summer25"');
    } finally {
      clearSavedFormData();
    }
  });

  test("leaves the box empty with no ?promo= prefill", () => {
    const html = singleListingPageHtml({ promoCodesEnabled: true });
    expect(html).toContain(
      'name="promo_code" placeholder="Optional" type="text" value=""',
    );
  });
});
