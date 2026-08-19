import type { ListingMoneyTotals } from "#accounting/listing-money-totals.ts";
import type { ListingAggregateRecalculation } from "#db/listings/aggregates.ts";
import type { SystemNote } from "#db/notes/types.ts";
import type {
  AttendeeListSetup,
  AttendeeListState,
} from "#shared/attendee-list-controls.ts";
import type { CheckedInStats } from "#templates/admin/detail-rows.tsx";
import type { TableQuestionData } from "#templates/attendee-table/types.ts";
import type { AdminSession, Attendee, Group, ListingWithCount } from "#types";

export type GroupContext = {
  group: Group;
  attendeeCount: number;
};

type ListingPanelSharedOptions = {
  aggregateRecalculation?: ListingAggregateRecalculation | undefined;
  questionData?: TableQuestionData | undefined;
  groupContext?: GroupContext | undefined;
  moneyTotals?: ListingMoneyTotals | undefined;
  ledgerHref?: string | undefined;
  isChild?: boolean | undefined;
  isHiddenPackageMember?: boolean | undefined;
  systemNotes?: SystemNote[] | undefined;
  /** Only owners may open the ledger pages, so a note's ledger link renders
   * as plain text for everyone else. */
  isOwner: boolean;
};

/** The roster's filter/sort description: its controls and current choices. */
export type RosterListView = {
  setup: AttendeeListSetup<null>;
  state: AttendeeListState<null>;
};

export type ListingPanelOptions = ListingPanelSharedOptions & {
  listing: ListingWithCount;
  attendees: Attendee[];
  allowedDomain: string;
  list: RosterListView;
  phonePrefix?: string | undefined;
  hasEmailableAttendees?: boolean | undefined;
  childNames?: string[] | undefined;
  paymentReferenceAttendeeIds?: ReadonlySet<number> | undefined;
};

export type OverviewStats = {
  adjustedCount: number;
  completeQuantitySum: number;
  checkedInStats: CheckedInStats;
  completeRevenue: number;
};

export type ListingOverviewPanelOptions = ListingPanelSharedOptions & {
  listing: ListingWithCount;
  allowedDomain: string;
  stats: OverviewStats;
  noteNames: Map<number, string>;
};

/** A selectable child candidate on the edit page's "required children" list: the
 * listing plus why it can't be a child of the one being edited (null when it
 * can). Ineligible candidates are pre-disabled (unless already ticked) so the
 * operator can't build an edge the save would only reject (usability #4). */
export type ChildCandidate = {
  listing: ListingWithCount;
  ineligibleReason: string | null;
};

/** The data the edit page's "required children" section renders. `candidates`
 * excludes the listing itself (no self-edges) and carries each one's
 * eligibility; `childIds` are its currently-required children; `offeredUnder` are
 * the listings it is itself a child of. */
export type ListingParentsSection = {
  candidates: ChildCandidate[];
  childIds: ReadonlySet<number>;
  offeredUnder: ListingWithCount[];
};

export type ListingEditPanelOptions = {
  listing: ListingWithCount;
  groups: Group[];
  session: AdminSession;
  error?: string | undefined;
  aggregateRecalculation?: ListingAggregateRecalculation | undefined;
  parents?: ListingParentsSection | undefined;
  selectedGroupIds?: number[] | undefined;
};
