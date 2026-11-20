/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/** Auto-populate the closing time from the listing date when it is empty. */

import { datetimePartNames } from "#shared/forms/datetime-parts.ts";

/** Fill one closing time part from its listing date part on change, while the
 *  closing part is still empty. */
const autofillPart = (listingPart: string, closingPart: string): void => {
  const source = document.querySelector<HTMLInputElement>(
    `input[name="${listingPart}"]`,
  );
  const target = document.querySelector<HTMLInputElement>(
    `input[name="${closingPart}"]`,
  );
  if (!source || !target) return;
  source.addEventListener("change", () => {
    if (source.value && !target.value) {
      target.value = source.value;
    }
  });
};

export const initClosesAtAutofill = (): void => {
  const listing = datetimePartNames("date");
  const closing = datetimePartNames("closesAt");
  autofillPart(listing.date, closing.date);
  autofillPart(listing.time, closing.time);
};
