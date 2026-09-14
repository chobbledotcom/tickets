import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { MAX_INPUT_LENGTH } from "#shared/limits.ts";
import { AddressFieldWithLookup } from "#templates/components/address-field.tsx";
import { withSetting } from "#test-utils/settings.ts";

describe("AddressFieldWithLookup", () => {
  const address = "12 Main Road, Leeds, LS1 1AA";

  test("renders the address textarea with its label and the input cap", () => {
    const html = String(AddressFieldWithLookup({ address }));

    expect(html).toContain(
      `<label for="address">Address<textarea autocomplete="off" id="address" maxlength="${MAX_INPUT_LENGTH}" name="address" rows="3">${address}</textarea></label>`,
    );
  });

  test("keeps the postcode search panel off when no provider is set", () => {
    const html = String(AddressFieldWithLookup({ address: "" }));

    expect(html).not.toContain("address-lookup");
    expect(html).toContain(
      `maxlength="${MAX_INPUT_LENGTH}" name="address" rows="3"></textarea>`,
    );
  });

  test("adds the postcode search panel above the textarea when a provider is active", async () => {
    await withSetting({ address_lookup_provider: "easypostcodes" }, () => {
      const html = String(AddressFieldWithLookup({ address }));

      expect(html).toContain('class="address-lookup"');
      // The saved address ends with its postcode, so the search box starts
      // pre-filled with it, normalised.
      expect(html).toContain(
        '<input autocomplete="off" data-address-search type="text" value="LS1 1AA">',
      );
      // The textarea stays editable and shows the saved address.
      expect(html).toContain(
        `maxlength="${MAX_INPUT_LENGTH}" name="address" rows="3">${address}</textarea>`,
      );
    });
  });

  test("leaves the search box empty when the address ends in no postcode", async () => {
    await withSetting({ address_lookup_provider: "easypostcodes" }, () => {
      // No comma, so there is no trailing part to offer as a search.
      const html = String(AddressFieldWithLookup({ address: "Flat 2" }));

      expect(html).toContain(
        '<input autocomplete="off" data-address-search type="text">',
      );

      // A trailing part that is not a postcode is normalised away, not shown.
      const html2 = String(
        AddressFieldWithLookup({ address: "12 Main Road, NOTAPEST" }),
      );

      expect(html2).toContain(
        '<input autocomplete="off" data-address-search type="text">',
      );
    });
  });
});
