import type {
  AttributeOption,
  AttributeWithOptions,
  ListingAttributesById,
} from "#db/attributes.ts";
import { filter, flatMap, map, pipe, reduce } from "#fp";
import { parsePositiveInt } from "#shared/validation/number.ts";
import type { ListingWithCount } from "#types";

type AttributeFilterOption = Pick<AttributeOption, "id" | "sortOrder" | "text">;

export type AttributeFilterGroup = {
  id: number;
  name: string;
  options: AttributeFilterOption[];
  sortOrder: number;
};

export type SelectedAttributeFilters = Map<number, number>;

export const attributeFilterParam = (attributeId: number): string =>
  `attribute_${attributeId}`;

type MutableFilterGroup = Omit<AttributeFilterGroup, "options"> & {
  options: Map<number, AttributeFilterOption>;
};

// Order by sortOrder, then by id to break ties. Works for both attributes and
// their options — anything that carries a sortOrder and an id.
const bySortOrderThenId = <T extends { sortOrder: number; id: number }>(
  left: T,
  right: T,
): number => left.sortOrder - right.sortOrder || left.id - right.id;

const addAttributeOptions = (
  filters: Map<number, MutableFilterGroup>,
  attribute: AttributeWithOptions,
): Map<number, MutableFilterGroup> => {
  const group = filters.get(attribute.id) ?? {
    id: attribute.id,
    name: attribute.name,
    options: new Map<number, AttributeFilterOption>(),
    sortOrder: attribute.sortOrder,
  };
  reduce(
    (options, option: AttributeOption) =>
      options.set(option.id, {
        id: option.id,
        sortOrder: option.sortOrder,
        text: option.text,
      }),
    group.options,
  )(attribute.options);
  return filters.set(attribute.id, group);
};

const addListingAttributes = (
  filters: Map<number, MutableFilterGroup>,
  attributes: AttributeWithOptions[],
): Map<number, MutableFilterGroup> =>
  reduce(addAttributeOptions, filters)(attributes);

const freezeFilterGroup = (
  group: MutableFilterGroup,
): AttributeFilterGroup => ({
  ...group,
  options: [...group.options.values()].toSorted(bySortOrderThenId),
});

export const attributeFilterGroupsForListings = (
  listingIds: number[],
  attributesByListing: ListingAttributesById,
): AttributeFilterGroup[] => {
  const groups = [
    ...reduce(
      (filters: Map<number, MutableFilterGroup>, listingId: number) =>
        addListingAttributes(filters, attributesByListing.get(listingId) ?? []),
      new Map<number, MutableFilterGroup>(),
    )(listingIds).values(),
  ];
  return pipe(
    map(freezeFilterGroup),
    filter((group: AttributeFilterGroup) => group.options.length > 0),
    (filtered: AttributeFilterGroup[]) => filtered.toSorted(bySortOrderThenId),
  )(groups);
};

export const selectedAttributeFiltersFromRequest = (
  request: Request,
  filters: AttributeFilterGroup[],
): SelectedAttributeFilters => {
  const params = new URL(request.url).searchParams;
  const selected = flatMap((group: AttributeFilterGroup) => {
    const value = params.get(attributeFilterParam(group.id));
    const optionId = value === null ? null : parsePositiveInt(value);
    return optionId !== null &&
      group.options.some((option) => option.id === optionId)
      ? [[group.id, optionId] as const]
      : [];
  })(filters);
  return new Map(selected);
};

const selectedOptionIds = (
  attributes: AttributeWithOptions[] | undefined,
): Set<number> =>
  new Set(
    pipe(
      flatMap((attribute: AttributeWithOptions) =>
        map((option: AttributeOption) => option.id)(attribute.options),
      ),
    )(attributes ?? []),
  );

export const filterListingsByAttributes =
  (
    selected: SelectedAttributeFilters,
    attributesByListing: ListingAttributesById,
  ) =>
  (listings: ListingWithCount[]): ListingWithCount[] => {
    const required = [...selected.values()];
    if (required.length === 0) return listings;
    return filter((listing: ListingWithCount) => {
      const listingOptions = selectedOptionIds(
        attributesByListing.get(listing.id),
      );
      return required.every((optionId) => listingOptions.has(optionId));
    })(listings);
  };
