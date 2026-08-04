import { t } from "#i18n";
import type { ListingAttributesById } from "#shared/db/attributes.ts";
import { renderFilterBar } from "#shared/filter-bar.ts";
import { escapeHtml } from "#shared/jsx/escape-html.ts";
import {
  type AttributeFilterGroup,
  attributeFilterParam,
  type SelectedAttributeFilters,
} from "#shared/listing-attribute-filter.ts";
import type { ListingFilter } from "#shared/listing-filter.ts";

export type ListingAttributeFilterView = {
  activeAttributeFilters: SelectedAttributeFilters;
  attributeFilters: AttributeFilterGroup[];
  attributesByListing: ListingAttributesById;
};

export const emptyAttributeFilterView = (): ListingAttributeFilterView => ({
  activeAttributeFilters: new Map(),
  attributeFilters: [],
  attributesByListing: new Map(),
});

const filterParams = (
  activeType: ListingFilter,
  activeAttributes: SelectedAttributeFilters,
): URLSearchParams => {
  const params = new URLSearchParams();
  if (activeType !== "all") params.set("type", activeType);
  for (const [attributeId, optionId] of activeAttributes) {
    params.set(attributeFilterParam(attributeId), String(optionId));
  }
  return params;
};

const hrefWithParams = (path: string, params: URLSearchParams): string => {
  const query = params.toString();
  return query ? `${path}?${query}` : path;
};

export const typeFilterHref =
  (path: string, activeAttributes: SelectedAttributeFilters) =>
  (type: ListingFilter): string =>
    hrefWithParams(path, filterParams(type, activeAttributes));

export const attributeFilterHref =
  (
    path: string,
    activeType: ListingFilter,
    activeAttributes: SelectedAttributeFilters,
  ) =>
  (attributeId: number, optionId: number | null): string => {
    const params = filterParams(activeType, activeAttributes);
    const name = attributeFilterParam(attributeId);
    if (optionId === null) params.delete(name);
    else params.set(name, String(optionId));
    return hrefWithParams(path, params);
  };

/** Build the CSV-export URL so it carries the current type and attribute
 *  filters through, keeping the download aligned with the filtered table. */
export const csvExportHref = (
  activeType: ListingFilter,
  activeAttributes: SelectedAttributeFilters,
): string =>
  hrefWithParams(
    "/admin/listings/csv",
    filterParams(activeType, activeAttributes),
  );

export const renderAttributeFilterBars = (
  filters: AttributeFilterGroup[],
  activeFilters: SelectedAttributeFilters,
  hrefFor: (attributeId: number, optionId: number | null) => string,
): string =>
  filters
    .map((filterGroup) =>
      renderFilterBar(escapeHtml(filterGroup.name), [
        {
          active: !activeFilters.has(filterGroup.id),
          href: hrefFor(filterGroup.id, null),
          label: t("attributes.filter.all"),
        },
        ...filterGroup.options.map((option) => ({
          active: activeFilters.get(filterGroup.id) === option.id,
          href: hrefFor(filterGroup.id, option.id),
          label: escapeHtml(option.text),
        })),
      ]),
    )
    .join("");
