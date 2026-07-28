/**
 * Shared readers for the API documentation tests. The docs are plain JSON
 * strings, so every check starts by finding an endpoint and reading a body.
 */

import type { EndpointDoc } from "#shared/admin-api-example.ts";

/** The running totals a record only gains by being booked, all at zero on a
 * record that was just created. Absent on a resource that has none. */
export const freshTotals = (
  example: Record<string, unknown>,
): Record<string, number> =>
  Object.fromEntries(
    ["attendee_count", "cost", "income", "profit", "tickets_count"]
      .filter((field) => field in example)
      .map((field) => [field, 0]),
  );

/** The documented endpoint for a method and path, or a loud failure naming the
 * one that has gone missing — the drift these tests exist to catch. */
export const documented = (
  endpoints: EndpointDoc[],
  method: string,
  path: string,
): EndpointDoc => {
  const found = endpoints.find(
    (endpoint) => endpoint.method === method && endpoint.path === path,
  );
  if (!found) throw new Error(`No documented endpoint for ${method} ${path}`);
  return found;
};

/** One value found inside a JSON body: where it sits, what it is, and the
 * field it belongs to. A value inside a list keeps its field's name, so a zero
 * among `group_ids` is still judged as an id. */
export type JsonLeaf = { field: string; value: unknown; where: string };

/** Every value inside a JSON body. */
export const jsonLeaves = (
  value: unknown,
  where: string,
  field = "",
): JsonLeaf[] => {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      jsonLeaves(entry, `${where}[${index}]`, field),
    );
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, entry]) =>
      jsonLeaves(entry, `${where}.${key}`, key),
    );
  }
  return [{ field, value, where }];
};

/** Fields that say how many of something, where zero means nothing to book. Two
 * kinds of field are deliberately left out: a price, because free is a real
 * price, and a capacity, because zero there means "no cap of its own". */
const COUNT_FIELDS = [
  "group_ids",
  "child_listing_ids",
  "quantity",
  "max_quantity",
  "maxPurchasable",
  "dayCount",
  "days",
  "id",
];

/** A value not worth documenting: blank text, a negative number, or a count of
 * none. `field` is the name the value was found under. */
export const isBlank = (value: unknown, field = ""): boolean => {
  if (typeof value === "string") return value.trim().length === 0;
  if (typeof value !== "number") return false;
  return value < 0 || (value === 0 && COUNT_FIELDS.includes(field));
};
