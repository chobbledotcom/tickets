/** Shared types for the reservations (ticket page) rendering pipeline. */

/* jscpd:ignore-start */
import type { CartDateItem } from "#booking/cart-conflicts.ts";
import type { ChildDatesByDayCount, TicketListing } from "#booking/model.ts";
import type { PagePackage } from "#booking/page-packages.ts";
import type { ListingAttributesById } from "#db/attributes.ts";
import type { AddOnOption } from "#db/modifier-resolve.ts";
import type { QuestionWithAnswers } from "#db/question-types.ts";
import type { QuestionListingMap } from "#db/questions/queries.ts";
import type { PublicNavProps } from "#templates/public/shared.tsx";
import type { GroupIdsByListingId, Image, ItemImageColumns } from "#types";
/* jscpd:ignore-end */

/** Quantity values parsed from ticket form */
export type TicketQuantities = Map<number, number>;

/** Per-listing pre-fill applied when scanning a signed QR link */
export type TicketPrefill = {
  quantity?: number;
  /** Pre-fill the custom_price input for can_pay_more listings (minor units) */
  customPriceMinor?: number;
};

/**
 * Per-parent child rendering inputs threaded down to the listing rows: the page's
 * children grouped by parent, the page questions and their listing map (to render
 * each child's questions), and a shared `rendered` set so a question shared by
 * sibling children (or by the parent) renders exactly once. Empty
 * `children` means the page has no parents and nothing extra renders.
 */
export type ChildRenderCtx = {
  children: Map<number, TicketListing[]>;
  /** Daily-child start dates for each parent day count. */
  childDatesById: ReadonlyMap<string, ChildDatesByDayCount>;
  /** Remaining spots for limited groups. */
  groupRemainingByGroupId: ReadonlyMap<number, number>;
  /** Groups each listing belongs to. */
  groupIdsByListingId: GroupIdsByListingId;
  questions: QuestionWithAnswers[];
  questionListingMap: QuestionListingMap | undefined;
  rendered: Set<number>;
  /** Child tickets already promised to parents on this page. */
  foldReserveByChildId: ReadonlyMap<number, number>;
  /** Selected listing attributes, for rendering on child options. */
  attributesByListing: ListingAttributesById;
};

/**
 * Pre-fill for the booking page: per-listing quantities (and optional price), an
 * optional pre-filled name/date, and — only for signed QR links — a token
 * re-submitted as a hidden field to authorise a price override. Any scenario that
 * lands a visitor on a booking form with listings pre-selected builds one: the QR
 * flow sets a single listing plus a `token`; the order cart sets many listings
 * (quantity 1 each) and no token.
 */
export type BookingPrefill = {
  /** Per-listing pre-fill — keyed by listing id */
  listings: Map<number, TicketPrefill>;
  /** Pre-fill name input */
  name?: string;
  /** Pre-fill date selector (for daily listings) */
  date?: string;
  /** Opaque signed token re-submitted via a hidden input to verify a price
   * override. Only signed QR booking links set this. */
  token?: string;
};

/** The render-path group-availability inputs shared by the ticket page options
 * and the render context: each capped group's remaining spots, and the group
 * ids each listing belongs to. Both are set only on the render path (so a parent
 * sharing a capped group with its child can clamp by the combined demand against
 * the specific shared group) and omitted on submit/quote. */
export type GroupAvailability = {
  groupRemainingByGroupId?: ReadonlyMap<number, number>;
  groupIdsByListingId?: GroupIdsByListingId;
};

/** Options for the ticket page */
export type TicketPageOptions = GroupAvailability & {
  listings: TicketListing[];
  slugs: string[];
  error?: string;
  dates?: string[];
  /** Each daily listing's own bookable dates — the facts the render-time cart
   * conflict rules read (see `#shared/booking/cart-conflicts.ts`). */
  cartDateItems?: readonly CartDateItem[];
  terms?: string | null;
  questions?: QuestionWithAnswers[];
  questionListingMap?: QuestionListingMap;
  baseUrl?: string;
  groupName?: string;
  groupDescription?: string;
  groupImage?: ItemImageColumns;
  /** The header entity's images, shown as the shared CSS gallery above the
   * form (empty ⇒ falls back to the single header image). */
  galleryImages?: readonly Image[];
  /** Selected listing attributes, populated only on render paths. */
  attributesByListing?: ListingAttributesById;
  prefill?: BookingPrefill | undefined;
  /** Override the <form action="…"> URL. Defaults to `/ticket/<slugs>`. */
  actionUrl?: string;
  /** Opt-in add-ons to offer below the questions. */
  addOns?: AddOnOption[];
  /** Whether to offer a promo-code field. */
  promoCodesEnabled?: boolean;
  /** Parent listing id → its children. Drives the per-parent child selector
   * rendered under each parent row. */
  childrenByParentId?: Map<number, TicketListing[]>;
  /** Daily-child start dates for each parent day count. */
  childDatesById?: ReadonlyMap<string, ChildDatesByDayCount>;
  /** The package bundles sold on this page, in page order. Each package's
   * members render under its own count selector instead of per-member
   * quantities; listings outside every package keep their own controls. */
  packages?: PagePackage[];
  /** Remaining spots for package member groups. */
  packageGroupRemainingByGroupId?: ReadonlyMap<number, number>;
  packageMemberGroupIds?: ReadonlyMap<number, number[]>;
  /** The public site menu, shown above the form on a normal page and dropped
   * in iframe mode. Set only on the render path; absent ⇒ no menu. */
  nav?: PublicNavProps;
};
