import { parsePositiveIntId } from "#shared/validation/number.ts";

export type LedgerScopeOption = { id: number; name: string };

/** The one selected ledger scope. A listing and group cannot both be active. */
export type LedgerScope =
  | { kind: "all" }
  | ({ kind: "listing" } & LedgerScopeOption)
  | ({ kind: "group" } & LedgerScopeOption);

export const ALL_LEDGER_SCOPE: LedgerScope = { kind: "all" };

const optionFromParam = (
  params: URLSearchParams,
  key: string,
  options: LedgerScopeOption[],
): LedgerScopeOption | undefined => {
  const raw = params.get(key);
  const id = raw === null ? null : parsePositiveIntId(raw);
  return id === null ? undefined : options.find((option) => option.id === id);
};

/** Resolve valid URL params to one scope. A valid listing wins; otherwise a
 * valid group is used, including when the listing param was invalid. */
export const resolveLedgerScope = (
  params: URLSearchParams,
  listings: LedgerScopeOption[],
  groups: LedgerScopeOption[],
): LedgerScope => {
  const listing = optionFromParam(params, "listing", listings);
  if (listing) return { ...listing, kind: "listing" };
  const group = optionFromParam(params, "group", groups);
  return group ? { ...group, kind: "group" } : ALL_LEDGER_SCOPE;
};

/** Replace the scope part of a ledger query string without touching its other
 * filters. */
export const setLedgerScopeParam = (
  params: URLSearchParams,
  scope: LedgerScope,
): void => {
  params.delete("listing");
  params.delete("group");
  switch (scope.kind) {
    case "all":
      return;
    case "listing":
      params.set("listing", String(scope.id));
      return;
    case "group":
      params.set("group", String(scope.id));
  }
};

/** Listing ids accepted by the transfer query. Null means every listing; an
 * empty selected group remains an empty array and therefore fails closed. */
export const listingIdsForLedgerScope = (
  scope: LedgerScope,
  groupListingIds: number[],
): number[] | null => {
  switch (scope.kind) {
    case "all":
      return null;
    case "listing":
      return [scope.id];
    case "group":
      return groupListingIds;
  }
};

export const ledgerScopeSelected = (
  current: LedgerScope,
  option: LedgerScope,
): boolean => {
  switch (option.kind) {
    case "all":
      return current.kind === "all";
    case "listing":
      return current.kind === "listing" && current.id === option.id;
    case "group":
      return current.kind === "group" && current.id === option.id;
  }
};
