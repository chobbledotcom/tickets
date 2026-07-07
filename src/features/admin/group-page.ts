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
 * The content-only editor role may edit a group but never saw its detail page,
 * so every tab except Edit is staff-gated and an editor's page resolves to just
 * the Edit tab. Sub-action POST handlers (add-listings, edit, delete) keep
 * their own routes in groups.ts; this file owns only the GET surface.
 */

/* jscpd:ignore-start */
import {
  type ActionDef,
  defineEntityPage,
  type EntityPage,
  type TabDef,
} from "#routes/admin/entity-pages.ts";
import { type AuthSession, requireContentOr } from "#routes/auth.ts";
/* jscpd:ignore-end */
import { isReadOnly } from "#shared/env.ts";
import { isStorageEnabled } from "#shared/storage.ts";
import { type Group, isContentRole, isStaffRole } from "#shared/types.ts";
import {
  loadGroupAttendeesPanel,
  loadGroupEditPanel,
  loadGroupForPage,
  loadGroupImagesPanel,
  loadGroupOverviewPanel,
} from "./group-page-data.ts";

/** Every tab except Edit was on the staff-only detail page (it decrypts
 * attendee PII), so gate them to staff; an editor's page resolves to Edit. */
const staffOnly = (_group: Group, session: AuthSession): boolean =>
  isStaffRole(session.adminLevel);

/** A tab whose one section is a custom-rendered panel — the shape every group
 * tab but Actions takes. Keeps the tab list declarative and free of repeated
 * `{ kind: "custom", load }` boilerplate. */
const panelTab = (
  slug: string,
  labelKey: string,
  load: (group: Group) => Promise<JSX.Element>,
  visible: (group: Group, session: AuthSession) => boolean,
): TabDef<Group> => ({
  labelKey,
  sections: [{ kind: "custom", load }],
  slug,
  visible,
});

/** The Actions tab entries. Each `visible` mirrors the gate its old detail-nav
 * link used, so no dead or forbidden link renders. The tab itself is open to
 * content roles (staff + editor), so Bulk actions and Delete now carry an
 * explicit `staffOnly` check — Export is the only button an editor may use. */
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
    labelKey: "groups.detail.bulk_actions",
    // Bulk actions mutate the group's listings, so hide the link in read-only
    // mode (matching the old detail nav, which only showed it when writable)
    // and restrict it to staff now that editors reach this tab too.
    visible: (group, session) => staffOnly(group, session) && !isReadOnly(),
  },
  {
    danger: true,
    href: (group) => `/admin/groups/${group.id}/delete`,
    icon: "trash-2",
    labelKey: "groups.detail.delete_group",
    visible: staffOnly,
  },
];

/** The Edit tab is content-gated but hidden in read-only mode: the global guard
 * redirects the edit route to /read-only, so rather than render a link that
 * immediately bounces (and so an editor's bare-URL default can't resolve onto an
 * un-editable form), hide the tab. */
const editVisible = (): boolean => !isReadOnly();
const imagesVisible = (): boolean => editVisible() && isStorageEnabled();

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
  basePath: (id) => `/admin/groups/${id}`,
  // Editors may edit; every other tab is staff-gated, so an editor's page
  // resolves to just the Edit tab.
  guard: requireContentOr,
  load: (id) => loadGroupForPage(id),
  // A single group is a page *within* the Groups section — highlight the top
  // link, no "Add" sub-nav (see attendee-page.ts).
  navActive: { section: "/admin/groups" },
  tabs: [
    panelTab("", "entity.tab.overview", loadGroupOverviewPanel, staffOnly),
    panelTab(
      "attendees",
      "entity.tab.attendees",
      loadGroupAttendeesPanel,
      staffOnly,
    ),
    panelTab("edit", "entity.tab.edit", loadGroupEditPanel, editVisible),
    panelTab(
      "images",
      "entity.tab.images",
      loadGroupImagesPanel,
      imagesVisible,
    ),
    actionsTab(),
  ],
  titleOf: (group) => group.name,
});
