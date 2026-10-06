/**
 * The group filter's view data for the admin listings index: the groups the
 * site stores and the one the visitor picked. The resolution from a group to
 * its member listings lives in the features, through the shared membership
 * reader. This type only carries what the page renders.
 */

import type { LedgerScopeOption } from "#shared/ledger-scope.ts";

export type ListingGroupFilterView = {
  activeGroupId: number | null;
  groups: LedgerScopeOption[];
};

export const emptyGroupFilterView = (): ListingGroupFilterView => ({
  activeGroupId: null,
  groups: [],
});
