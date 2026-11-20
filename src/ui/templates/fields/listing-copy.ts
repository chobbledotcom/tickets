import { t } from "#i18n";
import type { ListingCopyContext } from "#shared/listing-templates.ts";

/** The nouns a listing form uses for its unit and its buyer. */
export type ListingCopy = {
  capacity: string;
  document: string;
  page: string;
  people: string;
  person: string;
  pricingHeading: string;
  unit: string;
  unitTitle: string;
  units: string;
};

const WORD_NAMES = [
  "capacity",
  "document",
  "page",
  "people",
  "person",
  "pricingHeading",
  "unit",
  "unitTitle",
  "units",
] as const satisfies readonly (keyof ListingCopy)[];

const localeKey = (name: (typeof WORD_NAMES)[number]): string =>
  name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

const word = (context: ListingCopyContext, name: (typeof WORD_NAMES)[number]) =>
  t(`listings_table.copy.${context}.${localeKey(name)}`);

/** The templated words for one listing form vocabulary. */
export const listingCopy = (context: ListingCopyContext): ListingCopy => {
  const copy = {} as ListingCopy;
  for (const name of WORD_NAMES) {
    copy[name] = word(context, name);
  }
  return copy;
};
