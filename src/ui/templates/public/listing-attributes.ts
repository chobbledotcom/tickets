import type {
  AttributeWithOptions,
  ListingAttributesById,
} from "#shared/db/attributes.ts";
import { escapeHtml } from "#shared/jsx/escape-html.ts";

const attributeOptionsText = (attribute: AttributeWithOptions): string =>
  attribute.options.map((option) => option.text).join(", ");

const renderAttribute = (attribute: AttributeWithOptions): string =>
  `<div><dt>${escapeHtml(attribute.name)}</dt><dd>${escapeHtml(
    attributeOptionsText(attribute),
  )}</dd></div>`;

export const renderListingAttributes = (
  attributes: readonly AttributeWithOptions[] | undefined,
): string =>
  attributes && attributes.length > 0
    ? `<dl class="listing-attributes">${attributes
        .map(renderAttribute)
        .join("")}</dl>`
    : "";

/** The attributes markup for one listing, looked up by its id. */
export const listingAttributesHtml = (
  attributesByListing: ListingAttributesById,
  listingId: number,
): string => renderListingAttributes(attributesByListing.get(listingId));
