import type { AttributeWithOptions } from "#shared/db/attributes.ts";
import { escapeHtml } from "#templates/layout.tsx";

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
