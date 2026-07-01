import type { ListingWithCount } from "#shared/types.ts";

/**
 * The canonical **booking-node tree** — one in-memory model that represents a
 * standalone listing, an ad-hoc multi-slug cart, a regular group, a package, and
 * parent/child folding as configurations of the *same* structure (see
 * `booking-unification.md`). Phase 1 introduces the model and a pure builder
 * ({@link import("./build-tree.ts").buildBookingTree}); later phases move the
 * fold, pricing, capacity, and revalidation walks onto it.
 *
 * This module is the single source of truth for two things every booking surface
 * must agree on:
 *  - **node identity** — the `nodeKey`/edge scheme a node is addressed by; and
 *  - **form field names** — the exact `name="…"` a node's control emits and the
 *    submit/API side parses back. Render and submit importing the *same* helpers
 *    is what keeps "behaviour identical" mechanically true rather than a promise.
 */

/** What page/root a tree was entered through. A standalone listing (or an ad-hoc
 * multi-slug cart) carries a slug *list*; a group/package carries its group id. */
export type RootRef =
  | { readonly kind: "listing"; readonly slugs: readonly string[] }
  | { readonly kind: "group"; readonly groupId: number }
  | { readonly kind: "package"; readonly groupId: number };

/** Signed/URL **non-line** context priced and revalidated *alongside* the node
 * tree, never as node prices (a QR price override, a renewal action, a balance
 * settlement, the parent post-payment redirect, and the `/order` URL quantity
 * prefill). Phase 1 only threads what render needs; Phase 2 signs the rest. */
export type EntryContext = {
  readonly qrPriceOverrideMinor?: number;
  readonly renewalSiteToken?: string;
  readonly balanceAttendeeId?: number;
  readonly parentThankYouUrl?: string;
  readonly urlPrefillByListingId?: ReadonlyMap<number, number>;
};

/** How a node hangs off its parent/root. `none` is a top-level standalone node;
 * the others record the edge (and its owning group/parent) a member/child came
 * through, so a listing reachable by more than one path stays distinguishable. */
export type EdgeRef =
  | { readonly kind: "none" }
  | { readonly kind: "group_member"; readonly groupId: number }
  | { readonly kind: "parent_child"; readonly parentId: number };

/** How many of a node an order takes. `REQUIRED`/`FIXED` are known before render
 * (a package member's `fixed × packageQty`); `OPTIONAL`/`BUYER_CHOICE` are chosen
 * by the buyer. */
export type QuantityRule =
  | { readonly kind: "REQUIRED"; readonly qty: number }
  | { readonly kind: "FIXED"; readonly qty: number }
  | { readonly kind: "OPTIONAL"; readonly min: number; readonly max: number }
  | { readonly kind: "BUYER_CHOICE" };

/** Which price a node charges. `OVERRIDE` (package price) wins, then `PAY_MORE`
 * (pay-what-you-want), then `DAY_PRICE` (daily/customisable), then `BASE`. */
export type PriceRule =
  | { readonly kind: "BASE" }
  | { readonly kind: "OVERRIDE"; readonly amountMinor: number }
  | {
      readonly kind: "PAY_MORE";
      readonly minMinor: number;
      readonly maxMinor: number;
    }
  | { readonly kind: "DAY_PRICE" };

/** Whether a node is ever named on a buyer surface. A `HIDDEN` node is dropped
 * from render, never rendered-then-hidden (hidden-package privacy invariant). */
export type Visibility = "SHOWN" | "HIDDEN";

/** A node's date/duration facet. `INHERIT` takes the parent's resolved span (a
 * folded child), the others carry their own date/span or none. */
export type DateSpan =
  | { readonly kind: "NONE" }
  | { readonly kind: "DATE"; readonly date: string }
  | {
      readonly kind: "SPAN";
      readonly date: string;
      readonly durationDays: number;
    }
  | { readonly kind: "INHERIT" };

/** One listing plus the facets every booking model already needs. `children` is
 * empty for a leaf; a package member that is a parent is simply a node one level
 * deeper — no special case. */
export type BookingNode = {
  readonly nodeKey: string;
  readonly listingId: number;
  readonly listing: ListingWithCount;
  readonly edgeRef: EdgeRef;
  readonly quantityRule: QuantityRule;
  readonly priceRule: PriceRule;
  readonly visibility: Visibility;
  readonly dateSpan: DateSpan;
  readonly children: readonly BookingNode[];
};

/** A whole booking: the root/page identity, the non-line entry context, and the
 * top-level nodes. */
export type BookingTree = {
  readonly rootRef: RootRef;
  readonly entry: EntryContext;
  readonly nodes: readonly BookingNode[];
};

// ---------------------------------------------------------------------------
// Node identity — the `nodeKey` scheme (single source of truth)
// ---------------------------------------------------------------------------

/** A standalone / group-member / package-member listing addressed by its own id. */
export const listingNodeKey = (listingId: number): string =>
  `listing:${listingId}`;

/** A regular (non-package) group member: the same listing under a different group
 * is a different node. */
export const groupMemberNodeKey = (
  groupId: number,
  listingId: number,
): string => `group:${groupId}/member:${listingId}`;

/** A package member: distinct from the standalone path so a package override and
 * a standalone price on the same listing never collapse. */
export const packageMemberNodeKey = (
  groupId: number,
  listingId: number,
): string => `package:${groupId}/member:${listingId}`;

/** A required child under a parent: the same child under two parents is two
 * nodes (its serveable dates and cap differ per parent). */
export const childNodeKey = (parentId: number, childId: number): string =>
  `parent:${parentId}/child:${childId}`;

// ---------------------------------------------------------------------------
// Form field names — the single source of truth render and submit share
// ---------------------------------------------------------------------------

/** The per-listing quantity control (`quantity_<id>`) — a standalone listing, a
 * multi-slug cart member, a regular group member, or a parent. */
export const quantityFieldName = (listingId: number): string =>
  `quantity_${listingId}`;

/** The pay-what-you-want price control for a top-level listing
 * (`custom_price_<id>`). */
export const customPriceFieldName = (listingId: number): string =>
  `custom_price_${listingId}`;

/** One child's per-unit quantity control (`child_qty_<parentId>_<childId>`). */
export const childQuantityFieldName = (
  parentId: number,
  childId: number,
): string => `child_qty_${parentId}_${childId}`;

/** One child's pay-what-you-want price control
 * (`child_price_<parentId>_<childId>`). */
export const childPriceFieldName = (
  parentId: number,
  childId: number,
): string => `child_price_${parentId}_${childId}`;

/** The single "number of packages" control on a package page. */
export const PACKAGE_QUANTITY_FIELD = "package_quantity";

/** The quantity form field a node's control posts, or `null` when the node has
 * no buyer-chosen quantity of its own (a package member — its quantity is the
 * package count × its fixed per-package quantity, submitted via
 * {@link PACKAGE_QUANTITY_FIELD}). This is the "stable nodeKey → field name"
 * projection: render emits it and submit parses it, from one place. */
export const nodeQuantityFieldName = (node: BookingNode): string | null => {
  switch (node.edgeRef.kind) {
    case "parent_child":
      return childQuantityFieldName(node.edgeRef.parentId, node.listingId);
    case "group_member":
      // A package member has no per-member quantity control; a regular group
      // member uses the ordinary per-listing quantity field.
      return node.quantityRule.kind === "FIXED"
        ? null
        : quantityFieldName(node.listingId);
    default:
      return quantityFieldName(node.listingId);
  }
};

/** The pay-more price form field a node's control posts, or `null` when the node
 * cannot be priced pay-what-you-want. Mirrors {@link nodeQuantityFieldName}. */
export const nodePriceFieldName = (node: BookingNode): string | null => {
  if (node.priceRule.kind !== "PAY_MORE") return null;
  return node.edgeRef.kind === "parent_child"
    ? childPriceFieldName(node.edgeRef.parentId, node.listingId)
    : customPriceFieldName(node.listingId);
};
