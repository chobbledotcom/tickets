import type { ListingAttributesById } from "#db/attributes.ts";
import { t } from "#i18n";
import { escapeHtml } from "#jsx/escape-html.ts";
import { renderFilterBar } from "#shared/filter-bar.ts";
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

/**
 * The filters one listings-page link keeps: the listing kind, the chosen
 * attribute options, and the chosen group. A null group keeps every group.
 */
export type ListingLinkFilters = {
  activeAttributes: SelectedAttributeFilters;
  groupId: number | null;
  type: ListingFilter;
};

const filterParams = ({
  activeAttributes,
  groupId,
  type,
}: ListingLinkFilters): URLSearchParams => {
  const params = new URLSearchParams();
  if (type !== "all") params.set("type", type);
  if (groupId !== null) params.set("group", String(groupId));
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
  (path: string, fixed: Omit<ListingLinkFilters, "type">) =>
  (type: ListingFilter): string =>
    hrefWithParams(path, filterParams({ ...fixed, type }));

export const attributeFilterHref =
  (path: string, filters: ListingLinkFilters) =>
  (attributeId: number, optionId: number | null): string => {
    const params = filterParams(filters);
    const name = attributeFilterParam(attributeId);
    if (optionId === null) params.delete(name);
    else params.set(name, String(optionId));
    return hrefWithParams(path, params);
  };

/** Link targets for the group filter bar: each keeps the current type and
 *  attribute filters and changes only the group. */
export const groupFilterHref =
  (path: string, fixed: Omit<ListingLinkFilters, "groupId">) =>
  (groupId: number | null): string =>
    hrefWithParams(path, filterParams({ ...fixed, groupId }));

/** Build the CSV-export URL so it carries the current type, group, and
 *  attribute filters through, keeping the download aligned with the filtered
 *  table. */
export const csvExportHref = (filters: ListingLinkFilters): string =>
  hrefWithParams("/admin/listings/csv", filterParams(filters));

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
