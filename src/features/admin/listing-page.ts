/**
 * The listing entity page (edit-pages.md, slice 2): one declarative definition
 * of the tabbed /admin/listing/:id page, collapsing what used to be the
 * separate detail and edit routes.
 *
 *   Overview   — read-only details table, income breakdown, notes, a short
 *                activity preview
 *   Attendees  — the roster (date + check-in filters), failed payments, quick
 *                add-attendee
 *   Activity   — the full activity log
 *   Actions    — duplicate / scanner / email / refund-all, danger zone:
 *                deactivate|reactivate, delete
 *
 * The banner (the deactivated warning) shows on every tab. Sub-action POST
 * handlers keep their own routes; this file only owns the GET surface.
 */

import { t } from "#i18n";
import {
  type ActionDef,
  defineEntityPage,
  type EntityPage,
  type TabDef,
} from "#routes/admin/entity-pages.ts";
import { requireSessionOr } from "#routes/auth.ts";
import { targetQuery } from "#shared/bulk-email-targets.ts";
import { isReadOnly } from "#shared/env.ts";
import { isPaidListing } from "#shared/types.ts";
import { ListingDeactivatedBanner } from "#templates/admin/listings.tsx";
import {
  type LoadedListing,
  loadListingActivity,
  loadListingForPage,
  loadListingOverviewPanel,
  loadListingRosterPanel,
} from "./listing-page-data.ts";

/** URL of a sub-action on this listing. */
const actionUrl = ({ listing }: LoadedListing, action: string): string =>
  `/admin/listing/${listing.id}/${action}`;

/** The Actions tab entries. Each `visible` mirrors the gate its old
 * {@link ListingActionNav} entry used, so no dead or forbidden link renders. */
const LISTING_ACTIONS: readonly ActionDef<LoadedListing>[] = [
  {
    href: (entity) => actionUrl(entity, "duplicate"),
    icon: "plus",
    labelKey: "listings_table.duplicate",
    visible: () => !isReadOnly(),
  },
  {
    href: (entity) => actionUrl(entity, "scanner"),
    icon: "search",
    labelKey: "listings_table.scanner",
    // The scanner checks tickets in; a purchase-only listing has no check-in.
    visible: ({ listing }) => !listing.purchase_only,
  },
  {
    href: ({ listing }) =>
      `/admin/emails${targetQuery({ kind: "listing", listingId: listing.id })}`,
    icon: "arrow-right",
    labelKey: "common.email",
    visible: (_entity, session) => session.adminLevel === "owner",
  },
  {
    danger: true,
    href: (entity) => actionUrl(entity, "refund-all"),
    icon: "credit-card",
    labelKey: "listings_table.refund_all",
    // Refunds only apply to a paid listing (the same gate the action bar used).
    visible: ({ listing }) => isPaidListing(listing),
  },
  {
    danger: true,
    href: (entity) => actionUrl(entity, "deactivate"),
    icon: "x",
    labelKey: "listings_table.deactivate",
    visible: ({ listing }) => listing.active,
  },
  {
    href: (entity) => actionUrl(entity, "reactivate"),
    icon: "rotate-ccw",
    labelKey: "listings_table.reactivate",
    visible: ({ listing }) => !listing.active,
  },
  {
    danger: true,
    href: (entity) => actionUrl(entity, "delete"),
    icon: "trash-2",
    labelKey: "common.delete",
  },
];

/** The Overview tab: the details panel plus a short activity preview. */
const overviewTab: TabDef<LoadedListing> = {
  labelKey: "entity.tab.overview",
  sections: [
    { kind: "custom", load: (entity) => loadListingOverviewPanel(entity) },
    {
      kind: "activity",
      load: (entity) => loadListingActivity(entity),
      viewAllTab: "activity",
    },
  ],
  slug: "",
};

/** The tabbed listing page. */
export const listingPage: EntityPage<LoadedListing> = defineEntityPage({
  banner: ({ listing }) =>
    Promise.resolve(ListingDeactivatedBanner({ active: listing.active })),
  basePath: (id) => `/admin/listing/${id}`,
  guard: requireSessionOr,
  load: (id) => loadListingForPage(id),
  navActive: "/admin/",
  tabs: [
    overviewTab,
    {
      labelKey: "entity.tab.attendees",
      sections: [{ kind: "custom", load: loadListingRosterPanel }],
      slug: "attendees",
    },
    {
      labelKey: "entity.tab.activity",
      sections: [{ kind: "activity", load: loadListingActivity }],
      slug: "activity",
    },
    {
      labelKey: "entity.tab.actions",
      sections: [
        {
          actions: LISTING_ACTIONS,
          kind: "actions",
          titleKey: "entity.tab.actions",
        },
      ],
      slug: "actions",
    },
  ],
  titleOf: ({ listing }) =>
    t("listings_table.detail_title", { name: listing.name }),
});
