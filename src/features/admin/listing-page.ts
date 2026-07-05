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
import { type AuthSession, requireContentOr } from "#routes/auth.ts";
import { targetQuery } from "#shared/bulk-email-targets.ts";
import { isReadOnly } from "#shared/env.ts";
import { isPaidListing, isStaffRole } from "#shared/types.ts";
import { ListingDeactivatedBanner } from "#templates/admin/listings/overview.tsx";
import {
  type LoadedListing,
  listingHasEmailableAttendees,
  loadListingActivity,
  loadListingActivityPreview,
  loadListingEditPanel,
  loadListingForPage,
  loadListingOverviewPanel,
  loadListingQrPanel,
  loadListingQuestionsPanel,
  loadListingRosterPanel,
} from "./listing-page-data.ts";

/** Tab visibility for the staff-only surfaces (roster, money, actions): the
 *  content-only `editor` role may edit a listing but never saw its detail page,
 *  so every tab except Edit is gated to staff, and an editor's default tab
 *  resolves to Edit. */
const staffOnly = (_entity: unknown, session: AuthSession): boolean =>
  isStaffRole(session.adminLevel);

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
    // A JSON export download (see catalog-transfer). Content-gated like the tab,
    // and a read, so — unlike duplicate — it stays available in read-only mode.
    href: (entity) => actionUrl(entity, "export.json"),
    icon: "save",
    labelKey: "catalog_transfer.export_link",
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
    // Owner-only, and only when there is someone to email — the compose page
    // 404s for a listing target with zero recipients, so a link without
    // emailable attendees would be a dead link (AGENTS.md: never render one).
    visible: (entity, session) =>
      session.adminLevel === "owner" && entity.hasEmailableAttendees,
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
      load: (entity) => loadListingActivityPreview(entity),
      viewAllTab: "activity",
    },
  ],
  slug: "",
  // Info + money: staff only (the old detail page was staff-only).
  visible: staffOnly,
};

/** The tabbed listing page. */
export const listingPage: EntityPage<LoadedListing> = defineEntityPage({
  banner: ({ listing }) =>
    Promise.resolve(ListingDeactivatedBanner({ active: listing.active })),
  basePath: (id) => `/admin/listing/${id}`,
  // The content-only editor role may edit; every other tab is staff-gated, so
  // an editor's page resolves to just the Edit tab.
  guard: requireContentOr,
  load: (id) => loadListingForPage(id),
  navActive: "/admin/",
  tabs: [
    overviewTab,
    {
      labelKey: "entity.tab.attendees",
      sections: [{ kind: "custom", load: loadListingRosterPanel }],
      slug: "attendees",
      visible: staffOnly,
    },
    {
      labelKey: "entity.tab.edit",
      sections: [
        {
          kind: "custom",
          load: (entity, ctx) => loadListingEditPanel(entity, ctx),
        },
      ],
      slug: "edit",
      // Editors and above may edit, but not in read-only mode — where the
      // global guard redirects the edit route to /read-only. Hide the tab then
      // rather than render a link that immediately bounces (and so an editor's
      // bare-URL default can't resolve onto an un-editable form).
      visible: () => !isReadOnly(),
    },
    {
      labelKey: "entity.tab.questions",
      sections: [
        {
          kind: "custom",
          load: (entity) => loadListingQuestionsPanel(entity),
        },
      ],
      slug: "questions",
      // The questions route is owner-only; visibility IS authorization, so a
      // non-owner never sees (or can name) the tab.
      visible: (_entity, session) => session.adminLevel === "owner",
    },
    {
      labelKey: "entity.tab.qr",
      sections: [
        { kind: "custom", load: (entity) => loadListingQrPanel(entity) },
      ],
      slug: "qr",
      // Staff-only, and a child / hidden-package listing has no standalone
      // booking page, so its booking QR would point at a dead /ticket link.
      // Hidden in read-only mode too: the QR form posts to
      // POST /admin/listing/:id/qr, which the read-only guard default-denies —
      // so a followable tab would carry an unsubmittable form.
      visible: (entity, session) =>
        staffOnly(entity, session) &&
        !entity.isChild &&
        !entity.isHiddenPackageMember &&
        !isReadOnly(),
    },
    {
      labelKey: "entity.tab.activity",
      sections: [{ kind: "activity", load: loadListingActivity }],
      slug: "activity",
      visible: staffOnly,
    },
    {
      labelKey: "entity.tab.actions",
      sections: [
        {
          actions: LISTING_ACTIONS,
          kind: "actions",
          // The Email action is the only one gating on hasEmailableAttendees,
          // and its recipient check decrypts PII — so resolve it here, when the
          // Actions tab renders, instead of on every tab's page load. Owner-only
          // (the sole role that sees Email); other staff skip the decrypt.
          prepare: async (entity, ctx) =>
            ctx.session.adminLevel === "owner"
              ? {
                  ...entity,
                  hasEmailableAttendees: await listingHasEmailableAttendees(
                    entity.listing.id,
                  ),
                }
              : entity,
          titleKey: "entity.tab.actions",
        },
      ],
      slug: "actions",
      visible: staffOnly,
    },
  ],
  titleOf: ({ listing }) =>
    t("listings_table.detail_title", { name: listing.name }),
});
