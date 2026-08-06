import type { ModifierSpec } from "#shared/payments.ts";
import type { RegistrationPackageFacts } from "#shared/registration-package-facts.ts";
import type { BookingLedgerDisposition } from "#shared/session-ledger.ts";
import type { GroupListing, ListingWithCount } from "#shared/types.ts";

export interface PaidOrderSnapshot {
  childrenByParentId: ReadonlyMap<number, number[]>;
  hiddenPackageMemberIds: ReadonlySet<number>;
  ledger: BookingLedgerDisposition;
  listingsById: ReadonlyMap<number, ListingWithCount>;
  modifierSpecs: ModifierSpec[];
  notificationPackages: RegistrationPackageFacts;
  parentsByChildId: ReadonlyMap<number, number[]>;
  publicStatusId: number;
}

export interface SnapshotGroupRow {
  hideListings: boolean;
  id: number;
  name: string;
}

export interface SnapshotDayPriceRow {
  days: number;
  groupId: number;
  listingId: number;
  unitPrice: number;
}

export interface SnapshotModifierRow {
  calcKind: ModifierSpec["kind"];
  calcValue: number;
  direction: "charge" | "discount";
  id: number;
  minVisits: number;
  name: string;
  scope: "all" | "groups" | "listings";
  trigger: ModifierSpec["trigger"];
}

export interface SnapshotRows {
  childEdges: Array<{ childId: number; parentId: number }>;
  groups: SnapshotGroupRow[];
  hiddenMemberIds: number[];
  ledger: { hasLegs: boolean; ownerAttendeeId: number | null };
  listings: ListingWithCount[];
  memberships: GroupListing[];
  modifierScopes: Array<{ listingId: number; modifierId: number }>;
  modifiers: SnapshotModifierRow[];
  publicStatusIds: number[];
  visitCounts: number[];
}
