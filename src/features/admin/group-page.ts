/**
 * The group entity page: one declarative definition of the tabbed
 * /admin/groups/:id page, collapsing what used to be the separate group detail
 * and edit routes.
 *
 *   Overview   — the group detail table, member-listings table, add-listings
 *                form (staff only — it decrypts attendee PII)
 *   Attendees  — the group roster, one row per booking line
 *   Edit       — the group form + per-listing package prices (content roles)
 *   Actions    — export JSON, bulk actions, danger zone: delete
 *
 * Content editors can use Edit, Images, and the safe entries on Actions. The
 * staff-only tabs retain their own visibility checks. Sub-action POST handlers
 * keep their own routes in groups.ts; this file owns only the GET surface.
 */

/* jscpd:ignore-start */
import {
  type ActionDef,
  defineEntityPage,
  type EntityPage,
  type TabDef,
} from "#routes/admin/entity-pages.ts";
import { panelTab, writeFormTab } from "#routes/admin/entity-write-tab.ts";
import type { AuthSession } from "#routes/auth.ts";
import { adminPattern } from "#shared/admin-surface.ts";
/* jscpd:ignore-end */
import { isStorageEnabled } from "#shared/storage.ts";
import {
  type Group,
  isContentRole,
  isOwnerRole,
  isStaffRole,
} from "#shared/types.ts";
import {
  loadGroupAttendeesPanel,
  loadGroupEditPanel,
  loadGroupForPage,
  loadGroupImagesPanel,
  loadGroupOverviewPanel,
} from "./group-page-data.ts";

/** Gate tabs that expose attendee PII or staff operations. */
const staffOnly = (_group: Group, session: AuthSession): boolean =>
  isStaffRole(session.adminLevel);

/** The Actions tab entries. Each `visible` repeats the gate its target route
 * enforces, so no dead or forbidden link renders. The tab itself is open to
 * content roles (staff + editor), so Bulk actions and Delete carry an explicit
 * `staffOnly` check — Export is the only button an editor may use. */
const GROUP_ACTIONS: readonly ActionDef<Group>[] = [
  {
    // A JSON export download (see catalog-transfer). A read, so — unlike bulk
    // actions and delete — it stays available in read-only mode.
    href: (group) => `/admin/groups/${group.id}/export.json`,
    icon: "save",
    labelKey: "catalog_transfer.export_link",
  },
  {
    href: (group) => `/admin/groups/${group.id}/bulk-actions`,
    icon: "hammer",
    intent: "write-form",
    labelKey: "groups.detail.bulk_actions",
    // Bulk actions mutate the group's listings, so hide the link in read-only
    // mode (matching the old detail nav, which only showed it when writable)
    // and restrict it to staff now that editors reach this tab too.
    visible: staffOnly,
  },
  {
    danger: true,
    href: (group) => `/admin/groups/${group.id}/delete`,
    icon: "trash-2",
    intent: "write-form",
    labelKey: "groups.detail.delete_group",
    visible: staffOnly,
  },
];

/** The Edit tab is content-gated but hidden in read-only mode: the global guard
 * redirects the edit route to /read-only, so rather than render a link that
 * immediately bounces (and so an editor's bare-URL default can't resolve onto an
 * un-editable form), hide the tab. */
const editVisible = (): boolean => true;
const imagesVisible = (): boolean => isStorageEnabled();

/** The Actions tab: the plain export/bulk links plus the delete danger zone.
 * Open to editors too — they may only use Export, since Bulk actions and
 * Delete each carry their own `staffOnly` check. */
const actionsTab = (): TabDef<Group> => ({
  labelKey: "entity.tab.actions",
  sections: [
    { actions: GROUP_ACTIONS, kind: "actions", titleKey: "entity.tab.actions" },
  ],
  slug: "actions",
  visible: (_group, session) => isContentRole(session.adminLevel),
});

/** The tabbed group page. */
export const groupPage: EntityPage<Group> = defineEntityPage({
  destination: "group",
  load: (id) => loadGroupForPage(id),
  // A single group is a page *within* the Groups section — highlight the top
  // link, no "Add" sub-nav (see attendee-page.ts).
  navActive: { section: adminPattern("groups") },
  tabs: [
    panelTab(
      "",
      "entity.tab.overview",
      (group, ctx) =>
        loadGroupOverviewPanel(group, isOwnerRole(ctx.session.adminLevel)),
      staffOnly,
    ),
    panelTab(
      "attendees",
      "entity.tab.attendees",
      (group) => loadGroupAttendeesPanel(group),
      staffOnly,
    ),
    writeFormTab("edit", "entity.tab.edit", loadGroupEditPanel, editVisible),
    writeFormTab(
      "images",
      "entity.tab.images",
      loadGroupImagesPanel,
      imagesVisible,
    ),
    actionsTab(),
  ],
  titleOf: (group) => group.name,
});
