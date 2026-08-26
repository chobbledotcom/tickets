/**
 * The impure shell of the tabbed admin "edit X" framework. Tab resolution and
 * strip building are pure, in `#shared/entity-pages/core.ts`.
 *
 * A GET runs only the active tab's section loaders. That is where the
 * cold-start win comes from.
 *
 * A failed POST re-renders at 400 carrying the submitted values, rather than
 * redirects and depends on the best-effort form stash surviving to the next
 * GET.
 */

import type { ActivityLogEntry } from "#db/activity-log.ts";
import { type AuthSession, recordPageGuardFor } from "#routes/auth.ts";
import { applyFlash } from "#routes/csrf.ts";
import { htmlResponse, notFoundResponse } from "#routes/response.ts";
import { getBaseUrl } from "#routes/url.ts";
import type { AdminRouteIntent } from "#shared/admin-surface/definitions.ts";
import type { AdminDestinationId } from "#shared/admin-surface/ids.ts";
import { adminDestination, adminRecordPath } from "#shared/admin-surface.ts";
import {
  resolveTabSlug,
  splitActions,
  type TabState,
  tabLinks,
  tabPath,
} from "#shared/entity-pages/core.ts";
import { isReadOnly } from "#shared/env.ts";
import {
  entityPageView,
  type LoadedSection,
  type ResolvedAction,
  type SummaryRow,
} from "#templates/admin/entity-pages.tsx";
import type { NavActive } from "#templates/admin/nav.tsx";
import type { IconName } from "#templates/components/actions.tsx";
import { isOwnerRole } from "#types";

/** Entity row key: numeric ids for ordinary tables, strings for blind-index
 * keyed pages like /admin/history/:hmac. */
export type EntityId = number | string;

/** Per-request context handed to every loader and href builder. */
export interface PageCtx {
  /** The request's origin (for absolute links, e.g. the customer pay link).
   * Empty on POST failure re-renders, which never build absolute links. */
  baseUrl: string;
  /** The request's query string (e.g. a `return_url` a caller threaded in). */
  query: URLSearchParams;
  /** The canonical URL of the active tab — what sub-actions return to. */
  returnUrl: string;
  session: AuthSession;
  /** Mint a sibling tab's URL (e.g. an Overview preview linking to the full
   * Activity tab). The only sanctioned way to build a tab URL. */
  tabHref: (slug: string) => string;
}

/** Add Actions-tab fields only owners need to load. */
export const prepareOwnerFields =
  <E>(
    load: (entity: E) => Promise<Partial<E>>,
  ): ((entity: E, ctx: PageCtx) => Promise<E>) =>
  async (entity, ctx) =>
    isOwnerRole(ctx.session.adminLevel)
      ? { ...entity, ...(await load(entity)) }
      : entity;

/** A loader for one of a page's optional element slots (banner, guide footer,
 * prose extra) or a custom section: it turns the entity into markup, or null
 * to render nothing. */
export type SlotLoader<E> = (
  entity: E,
  ctx: PageCtx,
) => Promise<JSX.Element | null>;

/** An operator action. `visible` must gate on the SAME condition the target
 * route enforces — a forbidden or dead action link is never rendered. */
/** Fields shared by any admin item that shows a label and may be hidden by
 * role: its `intent`, its `labelKey`, and its server-side `visible` guard. */
export interface AdminGatedItem<E> {
  intent?: AdminRouteIntent;
  labelKey: string;
  visible?: (entity: E, session: AuthSession) => boolean;
}

export interface ActionDef<E> extends AdminGatedItem<E> {
  /** Renders in the visually separated danger zone (delete, deactivate…). */
  danger?: boolean;
  descriptionKey?: string;
  href: (entity: E, ctx: PageCtx) => string;
  icon?: IconName;
}

/**
 * The closed union of section kinds. The loader below dispatches on `kind`
 * exhaustively — a new kind is a compile error there and in the renderer's
 * `SECTION_RENDERERS` until both arms exist.
 */
export type Section<E> =
  | {
      kind: "summary";
      rows: (entity: E, ctx: PageCtx) => Promise<SummaryRow[]>;
    }
  | {
      kind: "activity";
      load: (entity: E) => Promise<ActivityLogEntry[]>;
      /** Link "view all" into this tab (an Overview preview sets it). */
      viewAllTab?: string;
    }
  | {
      kind: "actions";
      titleKey: string;
      actions: readonly ActionDef<E>[];
      /** Optional per-tab augmentation run only when this (Actions) tab renders,
       * so an action's `visible` predicate can gate on data too expensive to
       * gather in the page-wide `load` — e.g. a decrypt that only the Actions
       * surface needs. Returns the entity the action predicates see. */
      prepare?: (entity: E, ctx: PageCtx) => Promise<E>;
    }
  | {
      kind: "custom";
      load: SlotLoader<E>;
    };

/** One tab: a URL segment, a strip label, and its ordered sections.
 * `visible` is evaluated server-side and IS authorization: a hidden tab is
 * absent from the strip and 404s when named directly. */
export interface TabDef<E> extends AdminGatedItem<E> {
  sections: readonly Section<E>[];
  slug: string;
}

/** One entity's whole page, as data. */
export interface EntityPageDef<E, Id extends EntityId = number> {
  /** Always-visible region above the tab strip (alerts, notes, status). */
  banner?: SlotLoader<E>;
  /** The route this page serves. Its declaration gives the page both its URLs
   * and its GET auth floor — the weakest role that may see any tab — so
   * neither is written here a second time. */
  destination: AdminDestinationId;
  /** A guide link rendered at the very bottom of the body via `GuideFooter`,
   *  matching every other admin page (e.g. the Site content editors). */
  guideFooter?: SlotLoader<E>;
  load: (id: Id, session: AuthSession) => Promise<E | null>;
  /** What the admin nav marks active. A single-item entity page passes
   * `{ section }` so the section's top link highlights without re-opening its
   * "Add" sub-nav; a page that IS a real section route (e.g. the Site content
   * editors, whose route is itself a sub-nav item) passes a plain route string. */
  navActive: NavActive;
  /** Extra content rendered inside the prose block beside the page `<h1>`
   *  (e.g. the attendee page's "Add a note" link). */
  proseExtra?: SlotLoader<E>;
  tabs: readonly TabDef<E>[];
  titleOf: (entity: E) => string;
}

/** Evaluate an action list's predicates and mint each href. */
const resolveActions = <E>(
  actions: readonly ActionDef<E>[],
  entity: E,
  ctx: PageCtx,
): ResolvedAction[] =>
  actions
    .filter(
      (action) =>
        !(isReadOnly() && action.intent === "write-form") &&
        action.visible?.(entity, ctx.session) !== false,
    )
    .map((action) => ({
      danger: action.danger === true,
      descriptionKey: action.descriptionKey,
      href: action.href(entity, ctx),
      icon: action.icon,
      labelKey: action.labelKey,
    }));

/** Run one section's IO, producing the renderer's plain view model. The
 * switch is exhaustive: without a `default`, a new kind fails to compile
 * until it returns here. */
const loadSection = async <E>(
  section: Section<E>,
  entity: E,
  ctx: PageCtx,
): Promise<LoadedSection> => {
  switch (section.kind) {
    case "summary":
      return { kind: "summary", rows: await section.rows(entity, ctx) };
    case "activity":
      return {
        entries: await section.load(entity),
        kind: "activity",
        viewAllHref:
          section.viewAllTab === undefined
            ? null
            : ctx.tabHref(section.viewAllTab),
      };
    case "actions": {
      const prepared = section.prepare
        ? await section.prepare(entity, ctx)
        : entity;
      const { plain, danger } = splitActions(
        resolveActions(section.actions, prepared, ctx),
      );
      return { danger, kind: "actions", plain, titleKey: section.titleKey };
    }
    case "custom":
      return { html: await section.load(entity, ctx), kind: "custom" };
  }
};

/** Options for {@link EntityPage.renderPage}: an HTTP status (400 for
 * failure re-renders) and an optional replacement panel for the active tab
 * (the failing form, submitted values and errors intact). */
export interface RenderPageOpts<E> {
  baseUrl?: string;
  panel?: SlotLoader<E>;
  query?: URLSearchParams;
  status?: number;
}

/** The bound page: `renderTab` for the two GET routes, `renderPage` for
 * POST failure re-renders, `path` for minting tab URLs everywhere else. */
export interface EntityPage<E, Id extends EntityId = number> {
  path: (id: Id, slug?: string) => string;
  renderPage: (
    session: AuthSession,
    id: Id,
    requestedTab: string,
    opts?: RenderPageOpts<E>,
  ) => Promise<Response>;
  renderTab: (
    request: Request,
    id: Id,
    requestedTab: string,
  ) => Promise<Response>;
}

/** Resolve one of the page's optional element slots (banner, guide footer,
 * prose extra): run its loader when present, else null. */
const resolveSlot = <E>(
  loader: SlotLoader<E> | undefined,
  entity: E,
  ctx: PageCtx,
): Promise<JSX.Element | null> =>
  loader ? loader(entity, ctx) : Promise.resolve(null);

type ResolvedPageTab<E> = {
  active: TabDef<E>;
  activeSlug: string;
  states: TabState[];
};

/** Resolve the visible tab strip and the requested active tab together. */
const resolvePageTab = <E>(
  tabs: readonly TabDef<E>[],
  entity: E,
  session: AuthSession,
  requestedTab: string,
): ResolvedPageTab<E> | null => {
  const states: TabState[] = tabs.map((tab) => ({
    labelKey: tab.labelKey,
    slug: tab.slug,
    visible:
      !(isReadOnly() && tab.intent === "write-form") &&
      tab.visible?.(entity, session) !== false,
  }));
  const activeSlug = resolveTabSlug(states, requestedTab);
  if (activeSlug === null) return null;
  return {
    active: tabs.find((tab) => tab.slug === activeSlug)!,
    activeSlug,
    states,
  };
};

/** Load either the rejected form panel or every section in the active tab. */
const loadPageSections = async <E>(
  active: TabDef<E>,
  entity: E,
  ctx: PageCtx,
  panel: SlotLoader<E> | undefined,
): Promise<LoadedSection[]> => {
  if (panel) return [{ html: await panel(entity, ctx), kind: "custom" }];
  return Promise.all(
    active.sections.map((section) => loadSection(section, entity, ctx)),
  );
};

/** Turn one page definition into its handlers + path helper. */
export const defineEntityPage = <E, Id extends EntityId = number>(
  def: EntityPageDef<E, Id>,
): EntityPage<E, Id> => {
  const basePath = (id: Id): string => adminRecordPath(def.destination, id);
  const guard = recordPageGuardFor(adminDestination(def.destination));
  const path = (id: Id, slug = ""): string => tabPath(basePath(id), slug);

  const renderPage = async (
    session: AuthSession,
    id: Id,
    requestedTab: string,
    opts: RenderPageOpts<E> = {},
  ): Promise<Response> => {
    const entity = await def.load(id, session);
    if (!entity) return notFoundResponse();
    const tab = resolvePageTab(def.tabs, entity, session, requestedTab);
    if (!tab) return notFoundResponse();
    const ctx: PageCtx = {
      baseUrl: opts.baseUrl ?? "",
      query: opts.query ?? new URLSearchParams(),
      returnUrl: path(id, tab.activeSlug),
      session,
      tabHref: (slug) => path(id, slug),
    };
    const sections = await loadPageSections(
      tab.active,
      entity,
      ctx,
      opts.panel,
    );
    const [banner, guideFooter, proseExtra] = await Promise.all([
      resolveSlot(def.banner, entity, ctx),
      resolveSlot(def.guideFooter, entity, ctx),
      resolveSlot(def.proseExtra, entity, ctx),
    ]);
    return htmlResponse(
      entityPageView({
        banner,
        guideFooter,
        navActive: def.navActive,
        proseExtra,
        sections,
        session,
        tabs: tabLinks(tab.states, basePath(id), tab.activeSlug),
        title: def.titleOf(entity),
      }),
      opts.status ?? 200,
    );
  };

  const renderTab = (
    request: Request,
    id: Id,
    requestedTab: string,
  ): Promise<Response> =>
    guard(request, (session) => {
      applyFlash(request);
      return renderPage(session, id, requestedTab, {
        baseUrl: getBaseUrl(request),
        query: new URL(request.url).searchParams,
      });
    });

  return { path, renderPage, renderTab };
};

/** A tab section that renders custom markup from a loader — the common shape
 * every panel section shares. */
export const customSection = <E>(load: SlotLoader<E>): Section<E> => ({
  kind: "custom",
  load,
});

/** The standard write-only Actions tab for an entity whose only action is a
 * type-the-name delete confirmation. */
export const deleteActionTab = <E>(
  labelKey: string,
  href: (entity: E, ctx: PageCtx) => string,
): TabDef<E> => ({
  intent: "write-form",
  labelKey: "entity.tab.actions",
  sections: [
    {
      actions: [
        {
          danger: true,
          href,
          icon: "trash-2",
          intent: "write-form",
          labelKey,
        },
      ],
      kind: "actions",
      titleKey: "entity.tab.actions",
    },
  ],
  slug: "actions",
});
