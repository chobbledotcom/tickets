/**
 * The address textarea with the postcode search panel above it — the one
 * address-entry block the admin attendee forms share (Edit tab and Logistics
 * tab). The panel renders only while a lookup provider is configured; the
 * textarea always stays editable.
 */

import { t } from "#i18n";
import { Raw } from "#jsx/jsx-runtime.ts";
import { renderAddressLookupPanel } from "#templates/components/address-lookup.tsx";

export const AddressFieldWithLookup = ({
  address,
}: {
  address: string;
}): JSX.Element => (
  <>
    <Raw html={renderAddressLookupPanel(address)} />
    <label for="address">
      {t("common.address")}
      <textarea
        autocomplete="off"
        id="address"
        maxlength={250}
        name="address"
        rows={3}
      >
        {address}
      </textarea>
    </label>
  </>
);
