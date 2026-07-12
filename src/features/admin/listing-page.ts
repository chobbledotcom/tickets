/**
 * The listing entity page (edit-pages.md, slice 2): one declarative definition
 * of the tabbed /admin/listing/:id page, collapsing what used to be the
 * separate detail and edit routes.
 *
 *   Overview   — read-only details table, income breakdown, notes, a short
 *                activity preview
 *   Attendees  — the roster (date + check-in filters), failed payments, quick
 *                add-attendee
 *   Scanner    — the check-in scanner (hidden for a "No Check-In" listing)
 *   Activity   — the full activity log
 *   Actions    — duplicate / export (open to editors too) / email /
 *                refund-all, danger zone: deactivate|reactivate|delete
 *                (staff only)
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
import { isStorageEnabled } from "#shared/storage.ts";
import {
  isContentRole,
  isOwnerRole,
  isPaidListing,
  isStaffRole,
} from "#shared/types.ts";
import { ListingDeactivatedBanner } from "#templates/admin/listings/overview.tsx";
import {
  type LoadedListing,
  listingHasEmailableAttendees,
  loadListingActivity,
  loadListingActivityPreview,
  loadListingForPage,
  loadListingOverviewPanel,
  loadListingRosterPanel,
} from "./listing-page-data.ts";
import {
  loadListingAttributesPanel,
  loadListingEditPanel,
  loadListingImagesPanel,
  loadListingQrPanel,
  loadListingQuestionsPanel,
} from "./listing-page-management-panels.ts";

/** Tab visibility for staff-only surfaces such as roster and money. Content
 * editors can use Edit, Images, and the safe entries on Actions. */
const staffOnly = (_entity: unknown, session: AuthSession): boolean =>
  isStaffRole(session.adminLevel);

/** Staff-only, and only when the listing also passes an extra check (e.g. it is
 * still active, or it is a paid listing). */
const staffAnd =
  (alsoAllowed: (entity: LoadedListing) => boolean) =>
  (entity: LoadedListing, session: AuthSession): boolean =>
    staffOnly(entity, session) && alsoAllowed(entity);

/** URL of a sub-action on this listing. */
const actionUrl = ({ listing }: LoadedListing, action: string): string =>
  `/admin/listing/${listing.id}/${action}`;

/** The Actions tab entries. Each `visible` mirrors the gate its old
 * {@link ListingActionNav} entry used, so no dead or forbidden link renders.
 * The tab itself is open to content roles (staff + editor), so every
 * mutation-risk entry below now carries its own explicit `staffOnly` check —
 * only Duplicate and Export are safe for an editor to use unrestricted. */
const LISTING_ACTIONS: readonly ActionDef<LoadedListing>[] = [
  {
    href: (entity) => actionUrl(entity, "duplicate"),
    icon: "plus",
    intent: "write-form",
    labelKey: "listings_table.duplicate",
  },
  {
    // A JSON export download (see catalog-transfer). Content-gated like the tab,
    // and a read, so — unlike duplicate — it stays available in read-only mode.
    href: (entity) => actionUrl(entity, "export.json"),
    icon: "save",
    labelKey: "catalog_transfer.export_link",
  },
  {
    href: ({ listing }) =>
      `/admin/emails${targetQuery({ kind: "listing", listingId: listing.id })}`,
    icon: "arrow-right",
    intent: "write-form",
    labelKey: "common.email",
    // Owner-only, and only when there is someone to email — the compose page
    // 404s for a listing target with zero recipients, so a link without
    // emailable attendees would be a dead link (AGENTS.md: never render one).
    visible: (entity, session) =>
      isOwnerRole(session.adminLevel) && entity.hasEmailableAttendees,
  },
  {
    danger: true,
    href: (entity) => actionUrl(entity, "refund-all"),
    icon: "credit-card",
    intent: "write-form",
    labelKey: "listings_table.refund_all",
    // Refunds only apply to a paid listing (the same gate the action bar used),
    // and moving money is staff-only — an editor never sees this button.
    visible: staffAnd((entity) => isPaidListing(entity.listing)),
  },
  {
    danger: true,
    href: (entity) => actionUrl(entity, "deactivate"),
    icon: "x",
    intent: "write-form",
    labelKey: "listings_table.deactivate",
    visible: staffAnd((entity) => entity.listing.active),
  },
  {
    href: (entity) => actionUrl(entity, "reactivate"),
    icon: "rotate-ccw",
    intent: "write-form",
    labelKey: "listings_table.reactivate",
    visible: staffAnd((entity) => !entity.listing.active),
  },
  {
    danger: true,
    href: (entity) => actionUrl(entity, "delete"),
    icon: "trash-2",
    intent: "write-form",
    labelKey: "common.delete",
    visible: staffOnly,
  },
];

/** The Overview tab: the details panel plus a short activity preview. */
const overviewTab: TabDef<LoadedListing> = {
  labelKey: "entity.tab.overview",
  sections: [
    {
      kind: "custom",
      load: (entity, ctx) =>
        loadListingOverviewPanel(entity, isOwnerRole(ctx.session.adminLevel)),
    },
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

const ownerWriteTab = (
  slug: string,
  labelKey: string,
  load: (entity: LoadedListing) => Promise<JSX.Element>,
): TabDef<LoadedListing> => ({
  intent: "write-form",
  labelKey,
  sections: [{ kind: "custom", load }],
  slug,
  visible: (_entity, session) => isOwnerRole(session.adminLevel),
});

/** The tabbed listing page. */
export const listingPage: EntityPage<LoadedListing> = defineEntityPage({
  banner: ({ listing }) =>
    Promise.resolve(ListingDeactivatedBanner({ active: listing.active })),
  basePath: (id) => `/admin/listing/${id}`,
  // Content editors can edit listings, manage their images, and use safe actions.
  guard: requireContentOr,
  load: (id) => loadListingForPage(id),
  // A single listing is a page *within* the Listings section — highlight the
  // top link, no "Add"/"Import" sub-nav. (This previously pointed at the Home
  // route purely to dodge the sub-nav; `{ section }` now expresses the intent
  // directly and highlights the correct section.)
  navActive: { section: "/admin/listings" },
  tabs: [
    overviewTab,
    {
      labelKey: "entity.tab.attendees",
      sections: [{ kind: "custom", load: loadListingRosterPanel }],
      slug: "attendees",
      visible: staffOnly,
    },
    {
      // The scanner is served by its own route (GET /admin/listing/:id/scanner,
      // scanner.ts) rather than this tab framework's section loaders — the
      // router tries literal paths before this page's /:tab wildcard, so that
      // route always wins and this tab renders no content of its own. Its
      // entry here exists only to promote the link into the top-level tab
      // strip (out of the Actions tab's action list), same slug and same
      // check-in gate the standalone route's link always used.
      labelKey: "listings_table.scanner",
      sections: [],
      slug: "scanner",
      visible: staffAnd((entity) => !entity.listing.purchase_only),
    },
    {
      intent: "write-form",
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
    },
    {
      intent: "write-form",
      labelKey: "entity.tab.images",
      sections: [{ kind: "custom", load: loadListingImagesPanel }],
      slug: "images",
      visible: () => isStorageEnabled(),
    },
    ownerWriteTab(
      "attributes",
      "entity.tab.attributes",
      loadListingAttributesPanel,
    ),
    ownerWriteTab(
      "questions",
      "entity.tab.questions",
      loadListingQuestionsPanel,
    ),
    {
      intent: "write-form",
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
      visible: staffAnd(
        (entity) => !entity.isChild && !entity.isHiddenPackageMember,
      ),
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
            isOwnerRole(ctx.session.adminLevel)
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
      // Open to editors too (unlike the other staff-only tabs): they may
      // still only use Duplicate and Export, since every other action above
      // carries its own `staffOnly` check.
      visible: (_entity, session) => isContentRole(session.adminLevel),
    },
  ],
  titleOf: ({ listing }) =>
    t("listings_table.detail_title", { name: listing.name }),
});
