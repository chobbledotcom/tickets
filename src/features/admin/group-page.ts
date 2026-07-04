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

import {
  type ActionDef,
  defineEntityPage,
  type EntityPage,
  type TabDef,
} from "#routes/admin/entity-pages.ts";
import { type AuthSession, requireContentOr } from "#routes/auth.ts";
import { isReadOnly } from "#shared/env.ts";
import { type Group, isStaffRole } from "#shared/types.ts";
import {
  loadGroupAttendeesPanel,
  loadGroupEditPanel,
  loadGroupForPage,
  loadGroupOverviewPanel,
} from "./group-page-data.ts";

/** Every tab except Edit was on the staff-only detail page (it decrypts
 * attendee PII), so gate them to staff; an editor's page resolves to Edit. */
const staffOnly = (_group: Group, session: AuthSession): boolean =>
  isStaffRole(session.adminLevel);

/** The Actions tab entries. Each `visible` mirrors the gate its old detail-nav
 * link used, so no dead or forbidden link renders. */
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
    // mode (matching the old detail nav, which only showed it when writable).
    visible: () => !isReadOnly(),
  },
  {
    danger: true,
    href: (group) => `/admin/groups/${group.id}/delete`,
    icon: "trash-2",
    labelKey: "groups.detail.delete_group",
  },
];

/** The Overview tab: the group detail table, member listings, add-listings. */
const overviewTab: TabDef<Group> = {
  labelKey: "entity.tab.overview",
  sections: [
    { kind: "custom", load: (group) => loadGroupOverviewPanel(group) },
  ],
  slug: "",
  visible: staffOnly,
};

/** The tabbed group page. */
export const groupPage: EntityPage<Group> = defineEntityPage({
  basePath: (id) => `/admin/groups/${id}`,
  // Editors may edit; every other tab is staff-gated, so an editor's page
  // resolves to just the Edit tab.
  guard: requireContentOr,
  load: (id) => loadGroupForPage(id),
  navActive: "/admin/groups",
  tabs: [
    overviewTab,
    {
      labelKey: "entity.tab.attendees",
      sections: [
        { kind: "custom", load: (group) => loadGroupAttendeesPanel(group) },
      ],
      slug: "attendees",
      visible: staffOnly,
    },
    {
      labelKey: "entity.tab.edit",
      sections: [
        { kind: "custom", load: (group) => loadGroupEditPanel(group) },
      ],
      slug: "edit",
      // Editors and above may edit, but not in read-only mode — where the
      // global guard redirects the edit POST. Hide the tab then rather than
      // render a form that can't submit (and so an editor's bare-URL default
      // can't resolve onto an un-editable form).
      visible: () => !isReadOnly(),
    },
    {
      labelKey: "entity.tab.actions",
      sections: [
        {
          actions: GROUP_ACTIONS,
          kind: "actions",
          titleKey: "entity.tab.actions",
        },
      ],
      slug: "actions",
      visible: staffOnly,
    },
  ],
  titleOf: (group) => group.name,
});
