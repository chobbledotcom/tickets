/**
 * Entity pages — the impure shell of the tabbed admin "edit X" framework
 * `defineEntityPage` turns one declarative page definition
 * (tabs of typed sections) into handlers the feature file binds under its
 * literal route keys:
 *
 *   "GET /admin/attendees/:attendeeId": (request, { attendeeId }) =>
 *     attendeePage.renderTab(request, attendeeId, ""),
 *   "GET /admin/attendees/:attendeeId/:tab": (request, { attendeeId, tab }) =>
 *     attendeePage.renderTab(request, attendeeId, tab),
 *
 * The GET flow: auth guard → load the entity (null → 404) → resolve the
 * requested tab against the viewer's visible set (unknown/hidden → 404) →
 * run ONLY the active tab's section loaders (per-tab loading is the
 * cold-start win) → render through the shared template. Tab resolution and
 * strip building are the pure core (#shared/entity-pages/core.ts); the
 * section loader below is the framework's one exhaustive kind-dispatch.
 *
 * POST failure feedback renders the SAME page in place at 400 via
 * {@link EntityPage.renderPage} with a sections override carrying the
 * submitted values and their errors — never a PRG bounce that depends on the
 * best-effort form stash surviving to the follow-up GET. Successes PRG to
 * {@link EntityPage.path} as everywhere else.
 */

import type { AuthSession, SessionGuard } from "#routes/auth.ts";
import { applyFlash } from "#routes/csrf.ts";
import { htmlResponse, notFoundResponse } from "#routes/response.ts";
import { getBaseUrl } from "#routes/url.ts";
import type { ActivityLogEntry } from "#shared/db/activityLog.ts";
import {
  resolveTabSlug,
  splitActions,
  type TabState,
  tabLinks,
  tabPath,
} from "#shared/entity-pages/core.ts";
import {
  entityPageView,
  type LoadedSection,
  type ResolvedAction,
  type SummaryRow,
} from "#templates/admin/entity-pages.tsx";
import type { NavActive } from "#templates/admin/nav.tsx";
import type { IconName } from "#templates/components/actions.tsx";

/** Entity row key: numeric ids for ordinary tables, strings for blind-index
 * keyed pages like /admin/history/:hmac. */
export type EntityId = number | string;

/** Per-request context handed to every loader and href builder. */
export interface PageCtx {
  session: AuthSession;
  /** The canonical URL of the active tab — what sub-actions return to. */
  returnUrl: string;
  /** Mint a sibling tab's URL (e.g. an Overview preview linking to the full
   * Activity tab). The only sanctioned way to build a tab URL. */
  tabHref: (slug: string) => string;
  /** The request's query string (e.g. a `return_url` a caller threaded in). */
  query: URLSearchParams;
  /** The request's origin (for absolute links, e.g. the customer pay link).
   * Empty on POST failure re-renders, which never build absolute links. */
  baseUrl: string;
}

/** An operator action. `visible` must gate on the SAME condition the target
 * route enforces — a forbidden or dead action link is never rendered. */
export interface ActionDef<E> {
  labelKey: string;
  descriptionKey?: string;
  icon?: IconName;
  href: (entity: E, ctx: PageCtx) => string;
  visible?: (entity: E, session: AuthSession) => boolean;
  /** Renders in the visually separated danger zone (delete, deactivate…). */
  danger?: boolean;
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
      load: (entity: E, ctx: PageCtx) => Promise<JSX.Element | null>;
    };

/** One tab: a URL segment, a strip label, and its ordered sections.
 * `visible` is evaluated server-side and IS authorization: a hidden tab is
 * absent from the strip and 404s when named directly. */
export interface TabDef<E> {
  slug: string;
  labelKey: string;
  visible?: (entity: E, session: AuthSession) => boolean;
  sections: readonly Section<E>[];
}

/** One entity's whole page, as data. */
export interface EntityPageDef<E, Id extends EntityId = number> {
  /** Concrete base URL for an id — URL minting only, never a route pattern. */
  basePath: (id: Id) => string;
  titleOf: (entity: E) => string;
  /** What the admin nav marks active. A single-item entity page passes
   * `{ section }` so the section's top link highlights without re-opening its
   * "Add" sub-nav; a page that IS a real section route (e.g. the Site content
   * editors, whose route is itself a sub-nav item) passes a plain route string. */
  navActive: NavActive;
  /** The GET auth floor — the weakest role that may see any tab. */
  guard: SessionGuard<AuthSession>;
  load: (id: Id, session: AuthSession) => Promise<E | null>;
  /** Always-visible region above the tab strip (alerts, notes, status). */
  banner?: (entity: E, ctx: PageCtx) => Promise<JSX.Element | null>;
  /** Extra content rendered inside the prose block beside the page `<h1>`
   *  (e.g. the attendee page's "Add a note" link). */
  proseExtra?: (entity: E, ctx: PageCtx) => Promise<JSX.Element | null>;
  /** A guide link rendered at the very bottom of the body via `GuideFooter`,
   *  matching every other admin page (e.g. the Site content editors). */
  guideFooter?: (entity: E, ctx: PageCtx) => Promise<JSX.Element | null>;
  tabs: readonly TabDef<E>[];
}

/** Evaluate an action list's predicates and mint each href. */
const resolveActions = <E>(
  actions: readonly ActionDef<E>[],
  entity: E,
  ctx: PageCtx,
): ResolvedAction[] =>
  actions
    .filter((action) => action.visible?.(entity, ctx.session) !== false)
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
 * failure re-renders) and an optional replacement for the active tab's
 * sections (the failing form, submitted values and errors intact). */
export interface RenderPageOpts<E> {
  status?: number;
  sections?: (entity: E, ctx: PageCtx) => Promise<LoadedSection[]>;
  query?: URLSearchParams;
  baseUrl?: string;
}

/** The bound page: `renderTab` for the two GET routes, `renderPage` for
 * POST failure re-renders, `path` for minting tab URLs everywhere else. */
export interface EntityPage<E, Id extends EntityId = number> {
  renderTab: (
    request: Request,
    id: Id,
    requestedTab: string,
  ) => Promise<Response>;
  renderPage: (
    session: AuthSession,
    id: Id,
    requestedTab: string,
    opts?: RenderPageOpts<E>,
  ) => Promise<Response>;
  path: (id: Id, slug?: string) => string;
}

/** Resolve one of the page's optional element slots (banner, guide footer,
 * prose extra): run its loader when present, else null. */
const resolveSlot = <E>(
  loader:
    | ((entity: E, ctx: PageCtx) => Promise<JSX.Element | null>)
    | undefined,
  entity: E,
  ctx: PageCtx,
): Promise<JSX.Element | null> =>
  loader ? loader(entity, ctx) : Promise.resolve(null);

/** Turn one page definition into its handlers + path helper. */
export const defineEntityPage = <E, Id extends EntityId = number>(
  def: EntityPageDef<E, Id>,
): EntityPage<E, Id> => {
  const path = (id: Id, slug = ""): string => tabPath(def.basePath(id), slug);

  const renderPage = async (
    session: AuthSession,
    id: Id,
    requestedTab: string,
    opts: RenderPageOpts<E> = {},
  ): Promise<Response> => {
    const entity = await def.load(id, session);
    if (!entity) return notFoundResponse();
    const tabStates: TabState[] = def.tabs.map((tab) => ({
      labelKey: tab.labelKey,
      slug: tab.slug,
      visible: tab.visible?.(entity, session) !== false,
    }));
    const activeSlug = resolveTabSlug(tabStates, requestedTab);
    if (activeSlug === null) return notFoundResponse();
    const active = def.tabs.find((tab) => tab.slug === activeSlug)!;
    const ctx: PageCtx = {
      baseUrl: opts.baseUrl ?? "",
      query: opts.query ?? new URLSearchParams(),
      returnUrl: path(id, activeSlug),
      session,
      tabHref: (slug) => path(id, slug),
    };
    const sections: LoadedSection[] = [];
    if (opts.sections) {
      sections.push(...(await opts.sections(entity, ctx)));
    } else {
      for (const section of active.sections) {
        sections.push(await loadSection(section, entity, ctx));
      }
    }
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
        tabs: tabLinks(tabStates, def.basePath(id), activeSlug),
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
    def.guard(request, (session) => {
      applyFlash(request);
      return renderPage(session, id, requestedTab, {
        baseUrl: getBaseUrl(request),
        query: new URL(request.url).searchParams,
      });
    });

  return { path, renderPage, renderTab };
};
