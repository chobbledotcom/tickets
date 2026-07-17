/**
 * Entity pages — the shared renderer for the tabbed admin "edit X" framework.
 * One page shell (title → banner → tab strip → sections)
 * plus an exhaustive per-kind section renderer. Tabs are plain links to real
 * URLs (full page loads), so the strip uses link semantics with
 * `aria-current="page"` — never ARIA tablist, which would misdescribe
 * navigation as same-page panel switching.
 *
 * The flash message needs no plumbing here: a redirect targeted at a form
 * renders inside that form's CsrfForm, and anything else is rendered by the
 * Layout backstop above the page content.
 */

/* jscpd:ignore-start */
import { compact } from "#fp";
import { t } from "#i18n";
import type { ActivityLogEntry } from "#shared/db/activityLog.ts";
import type { TabLink } from "#shared/entity-pages/core.ts";
import { getFlashFormId } from "#shared/flash-context.ts";
import { requestFlash } from "#shared/forms/flash.tsx";
import type { Child } from "#shared/jsx/jsx-runtime.ts";
import type { AdminSession } from "#shared/types.ts";
import { ActivityLogTable } from "#templates/admin/activityLog.tsx";
import { AdminPage } from "#templates/admin/admin-page.tsx";
import type { NavActive } from "#templates/admin/nav.tsx";
import { ActionButton, type IconName } from "#templates/components/actions.tsx";
import { DetailTable } from "#templates/components/detail-table.tsx";
import {
  PageBlock,
  PageRegions,
} from "#templates/components/page-structure.tsx";
/* jscpd:ignore-end */

/** One row of a read-only summary table. `href` renders the value as a link
 * (`external` adds target=_blank); neither ⇒ plain content. Omit a row
 * entirely rather than rendering a dead link. */
export interface SummaryRow {
  external?: boolean;
  href?: string;
  labelKey: string;
  value: JSX.Element | string;
}

/** An operator action with its predicates already evaluated and its href
 * already minted — plain data the renderer can draw without thinking. */
export interface ResolvedAction {
  danger: boolean;
  descriptionKey?: string | undefined;
  href: string;
  icon?: IconName | undefined;
  labelKey: string;
}

/** The active tab's sections with all IO already done — the renderer's whole
 * input contract, one arm per section kind. */
export type LoadedSection =
  | { kind: "summary"; rows: SummaryRow[] }
  | {
      kind: "activity";
      entries: ActivityLogEntry[];
      viewAllHref: string | null;
    }
  | {
      kind: "actions";
      titleKey: string;
      plain: ResolvedAction[];
      danger: ResolvedAction[];
    }
  | { kind: "custom"; html: JSX.Element | null };

/** A summary value, linked when the row carries an href (plain text otherwise —
 * a bare string is a valid JSX child, so no wrapping fragment is needed). */
const summaryValue = (row: SummaryRow): JSX.Element | string =>
  row.href ? (
    <a
      href={row.href}
      {...(row.external ? { rel: "noopener", target: "_blank" } : {})}
    >
      {row.value}
    </a>
  ) : (
    row.value
  );

/** The read-only key/value summary table. */
const SummarySection = ({
  section,
}: {
  section: Extract<LoadedSection, { kind: "summary" }>;
}): JSX.Element => (
  <DetailTable>
    {section.rows.map((row) => (
      <tr>
        <th scope="row">{t(row.labelKey)}</th>
        <td>{summaryValue(row)}</td>
      </tr>
    ))}
  </DetailTable>
);

/** The activity log (full, or a preview with a "view all" link into the
 * Activity tab). */
const ActivitySection = ({
  section,
}: {
  section: Extract<LoadedSection, { kind: "activity" }>;
}): JSX.Element => (
  <>
    <ActivityLogTable entries={section.entries} />
    {section.viewAllHref && (
      <p>
        <a href={section.viewAllHref}>{t("entity.view_all_activity")}</a>
      </p>
    )}
  </>
);

/** One action button row. */
const ActionRow = ({ action }: { action: ResolvedAction }): JSX.Element => (
  <div class="entity-action">
    <ActionButton
      href={action.href}
      {...(action.icon ? { icon: action.icon } : {})}
      variant="secondary"
    >
      {t(action.labelKey)}
    </ActionButton>
    {action.descriptionKey && (
      <span class="muted small">{t(action.descriptionKey)}</span>
    )}
  </div>
);

/** A run of action buttons, one per action. */
const ActionRows = ({
  actions,
}: {
  actions: ResolvedAction[];
}): JSX.Element => (
  <>
    {actions.map((action) => (
      <ActionRow action={action} />
    ))}
  </>
);

/** An `<article>` led by a translated `<h3>` heading, then its content. The
 * actions section here and the logistics "other attendees" list share this
 * shell (it disappears via its caller's own guard when there's nothing to show). */
export const TitledSection = ({
  titleKey,
  children,
}: {
  titleKey: string;
  children: Child;
}): JSX.Element => (
  <article>
    <h3>{t(titleKey)}</h3>
    {children}
  </article>
);

/** The action list: plain actions first, then the visually separated danger
 * zone. Either half disappears entirely when empty. */
const ActionsSection = ({
  section,
}: {
  section: Extract<LoadedSection, { kind: "actions" }>;
}): JSX.Element | null => {
  if (section.plain.length === 0 && section.danger.length === 0) return null;
  return (
    <TitledSection titleKey={section.titleKey}>
      <ActionRows actions={section.plain} />
      {section.danger.length > 0 && (
        <div class="entity-danger-zone">
          <h4>{t("entity.danger_zone")}</h4>
          <ActionRows actions={section.danger} />
        </div>
      )}
    </TitledSection>
  );
};

/** The exhaustive kind → renderer table. A new section kind is a compile
 * error here until its arm exists. */
const SECTION_RENDERERS: {
  [K in LoadedSection["kind"]]: (
    section: Extract<LoadedSection, { kind: K }>,
  ) => JSX.Element | null;
} = {
  actions: (section) => ActionsSection({ section }),
  activity: (section) => ActivitySection({ section }),
  custom: (section) => section.html,
  summary: (section) => SummarySection({ section }),
};

/** Render one loaded section through the exhaustive table. */
export const renderSection = (section: LoadedSection): JSX.Element | null =>
  SECTION_RENDERERS[section.kind](section as never);

/** The tab strip: plain links, active one marked with aria-current. */
const TabStrip = ({ tabs }: { tabs: TabLink[] }): JSX.Element => (
  <nav aria-label={t("entity.tabs_label")} class="entity-tabs">
    <ul>
      {tabs.map((tab) => (
        <li>
          <a
            aria-current={tab.active ? "page" : undefined}
            class={tab.active ? "active" : undefined}
            href={tab.href}
          >
            {t(tab.labelKey)}
          </a>
        </li>
      ))}
    </ul>
  </nav>
);

/** Everything the page shell needs, all IO already done. */
export interface EntityPageView {
  banner: JSX.Element | null;
  /** Optional guide link rendered at the very bottom of the body, matching the
   *  `GuideFooter` every other admin page uses (e.g. the Site content editors'
   *  "Guide: pages, news & images" link). */
  guideFooter?: JSX.Element | null;
  navActive: NavActive;
  /** Optional extra content rendered inside the prose block, right after the
   *  `<h1>` (e.g. the attendee page's "Add a note" link). */
  proseExtra?: JSX.Element | null;
  sections: LoadedSection[];
  session: AdminSession;
  tabs: TabLink[];
  title: string;
}

/** The whole entity page: title → banner → tab strip → active tab's sections,
 * in order. Peer regions use page spacing; each section keeps its related
 * heading, table, and actions together as one block. Empty sections disappear. */
export const entityPageView = (view: EntityPageView): string =>
  String(
    <AdminPage
      active={view.navActive}
      contentClassName="entity-page"
      session={view.session}
      title={view.title}
    >
      {getFlashFormId() === undefined && requestFlash()}
      <div class="prose entity-header">
        <h1>{view.title}</h1>
        {view.proseExtra}
      </div>
      {view.banner}
      <TabStrip tabs={view.tabs} />
      <PageRegions className="entity-tab-panel">
        {compact(view.sections.map(renderSection)).map((section) => (
          <PageBlock>{section}</PageBlock>
        ))}
      </PageRegions>
      {view.guideFooter}
    </AdminPage>,
  );
