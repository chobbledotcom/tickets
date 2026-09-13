/**
 * The promo-code box on the booking form: its presence with codes enabled,
 * the value a failed submit kept, and the `?promo=` URL pre-fill that fills
 * the box only when nothing was typed. Kept apart from the catch-all form
 * test file so each stays under the size limit.
 */

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

describe("the promo-code box", () => {
  beforeAll(setupAdminPageTest);
  registerPublicTemplateHooks();

  test("omits the box when promo codes are disabled", () => {
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

  test("prefills the promo code from the URL", () => {
    const html = singleListingPageHtml({
      prefill: { listings: new Map(), promo: "save10" },
      promoCodesEnabled: true,
    });
    expect(html).toContain(
      'name="promo_code" placeholder="Optional" type="text" value="save10"',
    );
  });

  test("restores the submitted promo code ahead of the URL code", () => {
    setSavedFormData(new FormParams({ promo_code: "TYPED" }));
    try {
      const html = singleListingPageHtml({
        prefill: { listings: new Map(), promo: "url-code" },
        promoCodesEnabled: true,
      });
      expect(html).toContain(
        'name="promo_code" placeholder="Optional" type="text" value="TYPED"',
      );
      expect(html).not.toContain('value="url-code"');
    } finally {
      clearSavedFormData();
    }
  });
});
