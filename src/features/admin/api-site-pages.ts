/**
 * Admin JSON API routes for site pages: the content pages (site_pages rows,
 * addressed by id) and the fixed pages home, contact and terms (by name).
 * Accessible via API key or cookie+CSRF. Site → Pages admits owners and
 * editors, so the JSON API matches. The terms editor is owner-only, and its
 * routes match.
 *
 * The writes do not go through the generic CRUD writer (defineCrudApi). A
 * page create carries its root order inside the INSERT. The slug index moves
 * with the slug. Create and update go through the same DB wrappers the form
 * uses (createSitePage, updateSitePage). A delete clears the page's tree
 * edges with the row (deleteSitePageWithEdges). The parsers and the auth
 * shape are the shared ones (crud-parsers).
 */

/* jscpd:ignore-start */
import { logActivity } from "#db/activity-log.ts";
import { type TxScope, withTransaction } from "#db/client.ts";
import { settings } from "#db/settings.ts";
import {
  deleteSitePageWithEdges,
  getAllPageItems,
} from "#db/site-page-items.ts";
import {
  createSitePage,
  getSitePageById,
  type SitePageWriteInput,
  sitePagesTable,
  updateSitePage,
} from "#db/site-pages.ts";
import { TransactionValidationError } from "#db/transaction.ts";
import { filter, map, pipe } from "#fp";
import { t } from "#i18n";
import { verifyIdentifierOrJsonError } from "#routes/admin/confirmation.ts";
import { apiErrorResponse } from "#routes/api/cors.ts";
import { OWNER_API, withAuth } from "#routes/auth.ts";
import { jsonResponse } from "#routes/response.ts";
import type { RouteHandlerFn } from "#routes/router.ts";
import {
  ADMIN_API_RESOURCES,
  type AdminApiSitePage,
} from "#shared/admin-api-resources.ts";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import {
  apiEntityGate,
  parseAndValidate,
  type RowBodyHandler,
} from "#shared/rest/crud-parsers.ts";
import type { Result } from "#shared/result.ts";
import { SITE_ADMIN_LEVELS, type SitePage, type SitePageItem } from "#types";
import { planParentChange, toPageWrite } from "./api-site-pages-input.ts";

/* jscpd:ignore-end */

const ENTRY = ADMIN_API_RESOURCES["site-pages"];
const RESPONSE_KEY = "page";

/** The page rows the list answers with, in the order the form's list shows. */
const LIST_ORDER = { order: "sort_order ASC, id ASC" } as const;

/** The page-write audience: the roles the Site → Pages form declares, with
 *  API-key auth. auth.ts holds the shared presets and sits at its size pin.
 *  This resource therefore carries its own. */
const SITE_API = {
  allowApiKey: true,
  body: "json",
  roles: SITE_ADMIN_LEVELS,
} as const;

/** Validate the mapped input, then run `run` with it. A mapping refusal
 *  answers its error response. The same shape crud-api.ts wraps its mappers
 *  in. */
const withValidated = async (
  raw: Result<SitePageWriteInput>,
  run: (input: SitePageWriteInput) => Promise<Response>,
): Promise<Response> => {
  const result = await parseAndValidate(raw);
  return result.ok ? run(result.input) : result.response;
};

// ─── Content-page reads ─────────────────────────────────────────

/** The child → parent map over the page edges: one page has at most one. */
const pageParents = (
  items: readonly SitePageItem[],
): ReadonlyMap<number, number> =>
  new Map(
    pipe(
      filter((item: SitePageItem) => item.item_type === "page"),
      map((item: SitePageItem) => [item.item_id, item.page_id] as const),
    )(items),
  );

const parentsNow = (): Promise<ReadonlyMap<number, number>> =>
  getAllPageItems().then(pageParents);

/** The API row for one stored page: the stored record without its slug HMAC,
 *  plus the page it nests under (null at the top level). */
const toRow = (
  page: SitePage,
  parents: ReadonlyMap<number, number>,
): AdminApiSitePage => {
  const { slug_index: _slugIndex, ...row } = page;
  return { ...row, parent: parents.get(page.id) ?? null };
};

/** The not-found answer the shared gate and the write path both use. */
const pageNotFound = (): Response =>
  apiErrorResponse(`${ENTRY.label} not found`, 404);

/** The gate every id-addressed route loads its page through. */
const pageGate = apiEntityGate(getSitePageById, ENTRY.label, SITE_API);

/** Serve `handler` with the page the route's id param names. */
const withPage =
  (handler: RowBodyHandler<SitePage>): RouteHandlerFn =>
  (request, params) =>
    pageGate(request, params.pageId as number, handler);

// ─── Content-page handlers ──────────────────────────────────────

const handleList: RouteHandlerFn = (request) =>
  withAuth(request, SITE_API, async () => {
    const [pages, parents] = await Promise.all([
      // The API's collection read: a client manages whole pages, so the list
      // answers the full stored row. This is the resource's one whole-table
      // read.
      sitePagesTable.read.many({}, LIST_ORDER),
      parentsNow(),
    ]);
    return jsonResponse({
      [ENTRY.path]: pages.map((page) => toRow(page, parents)),
    });
  });

const handleGet: RouteHandlerFn = withPage(async (page) =>
  jsonResponse({ [RESPONSE_KEY]: toRow(page, await parentsNow()) }),
);

const handleCreate: RouteHandlerFn = (request) =>
  withAuth(request, SITE_API, (_session, body) =>
    withValidated(toPageWrite(body, null), async (input) => {
      // A new page is always a root page: createSitePage appends its root
      // order inside the INSERT. The slug condition inside it refuses a slug
      // a listing, group, or page already owns.
      const created = await createSitePage(input);
      if (!created.ok) {
        return apiErrorResponse(t("site.pages.error.slug_taken"));
      }
      await logActivity(`${ENTRY.label} '${created.value.name}' created`);
      return jsonResponse(
        { [RESPONSE_KEY]: toRow(created.value, await parentsNow()) },
        201,
      );
    }),
  );

/** The update's transactional half: the row write and the parent edge commit
 *  together. The update's own refusals (a taken slug, a row that vanished)
 *  write nothing, so they return cleanly. Only a lost eligibility race
 *  throws, and the throw rolls the whole transaction back. */
const writeUpdate = async (
  page: SitePage,
  input: SitePageWriteInput,
  parentChange: ((tx: TxScope) => Promise<boolean>) | null,
): Promise<{ refusal: Response } | { row: SitePage }> => {
  const outcome = await withTransaction(async (tx) => {
    const result = await updateSitePage(page.id, input, tx);
    if (!result.ok) return { error: result.error };
    if (parentChange && !(await parentChange(tx))) {
      throw new TransactionValidationError(t("site.pages.error.ineligible"));
    }
    return { row: result.value };
  }).catch((error: unknown) => {
    if (error instanceof TransactionValidationError) {
      return { conflict: t("site.pages.error.ineligible") } as const;
    }
    throw error;
  });
  if ("conflict" in outcome) {
    return { refusal: apiErrorResponse(outcome.conflict) };
  }
  if ("error" in outcome) {
    return {
      refusal:
        outcome.error === "slugTaken"
          ? apiErrorResponse(t("site.pages.error.slug_taken"))
          : pageNotFound(),
    };
  }
  return outcome;
};

const handleUpdate: RouteHandlerFn = withPage(async (page, body) =>
  withValidated(toPageWrite(body, page), async (input) => {
    let parentChange: ((tx: TxScope) => Promise<boolean>) | null = null;
    if (body.parent !== undefined) {
      const plan = await planParentChange(page, body.parent);
      if (!plan.ok) return apiErrorResponse(plan.error);
      parentChange = plan.value;
    }
    const outcome = await writeUpdate(page, input, parentChange);
    if ("refusal" in outcome) return outcome.refusal;
    await logActivity(`${ENTRY.label} '${outcome.row.name}' updated`);
    return jsonResponse({
      [RESPONSE_KEY]: toRow(outcome.row, await parentsNow()),
    });
  }),
);

const handleDelete: RouteHandlerFn = withPage(async (page, body) => {
  const error = verifyIdentifierOrJsonError(
    page.name,
    body.confirm_identifier,
    `${ENTRY.label} name`,
  );
  if (error) return apiErrorResponse(error);
  // The delete clears the page's tree edges with the row, so its children
  // become top-level pages the same way the form's delete leaves them.
  await deleteSitePageWithEdges(page.id);
  await logActivity(`${ENTRY.label} '${page.name}' deleted`);
  return jsonResponse({ status: "ok" });
});

// ─── Fixed pages ────────────────────────────────────────────────

/** The three fixed pages: no id and no site_pages row. Each carries one
 *  editable text field, the auth its own editor declares, and the log line
 *  the form's save writes. */
const FIXED_PAGES = {
  contact: {
    label: () => t("site.contact.text_label"),
    log: () => "Contact page updated",
    policy: SITE_API,
    read: () => settings.contactPageText,
    update: (value: string) => settings.update.contactPageText(value),
  },
  home: {
    label: () => t("site.home.text_label"),
    log: () => "Homepage updated",
    policy: SITE_API,
    read: () => settings.homepageText,
    update: (value: string) => settings.update.homepageText(value),
  },
  terms: {
    label: () => t("settings.terms"),
    log: (value: string) =>
      value === "" ? t("success.terms_removed") : t("success.terms_updated"),
    policy: OWNER_API,
    read: () => settings.terms,
    update: (value: string) => settings.update.terms(value),
  },
} as const;

type FixedPageName = keyof typeof FIXED_PAGES;

const fixedPageRow = (name: FixedPageName): AdminApiSitePage => ({
  content: FIXED_PAGES[name].read(),
  name,
});

/** Serve `run` under the fixed page's own editor audience. */
const withFixedPage =
  (
    name: FixedPageName,
    run: (body: Record<string, unknown>) => Response | Promise<Response>,
  ): RouteHandlerFn =>
  (request) =>
    withAuth(request, FIXED_PAGES[name].policy, (_session, body) => run(body));

/** Read one fixed page's content. */
const fixedPageGet = (name: FixedPageName): RouteHandlerFn =>
  withFixedPage(name, () =>
    jsonResponse({ [RESPONSE_KEY]: fixedPageRow(name) }),
  );

/** Update one fixed page's editable content — the only field it has. The
 *  name-addressed create and delete routes refuse the rest, so a body that
 *  carries the Hidden box is refused here before anything else. */
const fixedPageUpdate = (name: FixedPageName): RouteHandlerFn =>
  withFixedPage(name, async (body) => {
    if (body.hidden !== undefined) {
      return apiErrorResponse("A fixed page cannot be hidden.");
    }
    if (body.content === undefined) {
      return apiErrorResponse("content is required");
    }
    if (typeof body.content !== "string") {
      return apiErrorResponse("content must be a string");
    }
    const value = body.content.trim();
    if (value.length > MAX_TEXTAREA_LENGTH) {
      return apiErrorResponse(
        t("fields.validation.max_length", {
          label: FIXED_PAGES[name].label(),
          max: MAX_TEXTAREA_LENGTH,
        }),
      );
    }
    await FIXED_PAGES[name].update(value);
    await logActivity(FIXED_PAGES[name].log(value));
    return jsonResponse({ [RESPONSE_KEY]: fixedPageRow(name) });
  });

/** The fixed pages cannot be created or deleted: they have no id and no row,
 *  so their name-addressed write routes answer the refusal directly. */
const refuseFixedPage = (
  name: FixedPageName,
  message: string,
): RouteHandlerFn => withFixedPage(name, () => apiErrorResponse(message));

// ─── Routes ─────────────────────────────────────────────────────

/** The fixed pages live on their own name-addressed routes. The route keys
 *  mirror the resource table's custom entries, so the routes and the docs
 *  cannot disagree. */
const fixedPageRoutes = (): Record<string, RouteHandlerFn> => ({
  [`DELETE /api/admin/${ENTRY.path}/contact`]: refuseFixedPage(
    "contact",
    "Fixed pages cannot be deleted.",
  ),
  [`DELETE /api/admin/${ENTRY.path}/home`]: refuseFixedPage(
    "home",
    "Fixed pages cannot be deleted.",
  ),
  [`DELETE /api/admin/${ENTRY.path}/terms`]: refuseFixedPage(
    "terms",
    "Fixed pages cannot be deleted.",
  ),
  [`GET /api/admin/${ENTRY.path}/contact`]: fixedPageGet("contact"),
  [`GET /api/admin/${ENTRY.path}/home`]: fixedPageGet("home"),
  [`GET /api/admin/${ENTRY.path}/terms`]: fixedPageGet("terms"),
  [`POST /api/admin/${ENTRY.path}/contact`]: refuseFixedPage(
    "contact",
    "Fixed pages cannot be created.",
  ),
  [`POST /api/admin/${ENTRY.path}/home`]: refuseFixedPage(
    "home",
    "Fixed pages cannot be created.",
  ),
  [`POST /api/admin/${ENTRY.path}/terms`]: refuseFixedPage(
    "terms",
    "Fixed pages cannot be created.",
  ),
  [`PUT /api/admin/${ENTRY.path}/contact`]: fixedPageUpdate("contact"),
  [`PUT /api/admin/${ENTRY.path}/home`]: fixedPageUpdate("home"),
  [`PUT /api/admin/${ENTRY.path}/terms`]: fixedPageUpdate("terms"),
});

export const sitePageApiRoutes: Record<string, RouteHandlerFn> = {
  "DELETE /api/admin/site-pages/:pageId": handleDelete,
  ...fixedPageRoutes(),
  "GET /api/admin/site-pages": handleList,
  "GET /api/admin/site-pages/:pageId": handleGet,
  "POST /api/admin/site-pages": handleCreate,
  "PUT /api/admin/site-pages/:pageId": handleUpdate,
};
