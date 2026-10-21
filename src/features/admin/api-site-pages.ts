/**
 * Admin JSON API routes for the site pages resource: the content pages
 * (site_pages rows, addressed by id). Site → Pages admits owners and
 * editors, so the JSON API matches. The fixed pages (home, contact and
 * terms) land with their own layer.
 *
 * The writes skip the generic CRUD writer (defineCrudApi): a create carries
 * its root order inside the INSERT, and the slug index moves with the slug.
 * Create and update go through the form's own DB wrappers (createSitePage,
 * updateSitePage). A delete clears the tree edges with the row
 * (deleteSitePageWithEdges). Parsers and auth are the shared ones.
 */

/* jscpd:ignore-start */
import { logActivity } from "#db/activity-log.ts";
import { type TxScope, withTransaction } from "#db/client.ts";
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
import { withAuth } from "#routes/auth.ts";
import { jsonResponse } from "#routes/response.ts";
import type { RouteHandlerFn } from "#routes/router.ts";
import {
  ADMIN_API_RESOURCES,
  type AdminApiSitePage,
} from "#shared/admin-api-resources.ts";
import {
  apiEntityGate,
  parseAndValidate,
  type RowBodyHandler,
} from "#shared/rest/crud-parsers.ts";
import { transactionValidationMessageOrRethrow } from "#shared/rest/write-error.ts";
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

const parentsNow = async (): Promise<ReadonlyMap<number, number>> =>
  pageParents(await getAllPageItems());

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

/** The gate every id-addressed route loads its page through. Its not-found is
 *  the same answer the write path gives a page that vanished mid-update. */
const pageGate = apiEntityGate(
  getSitePageById,
  ENTRY.label,
  SITE_API,
  pageNotFound,
);

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

/** What each failed update answers: the write's own not-found, or the form's
 *  taken-slug refusal. */
const updateRefusal: Record<"notFound" | "slugTaken", () => Response> = {
  notFound: pageNotFound,
  slugTaken: () => apiErrorResponse(t("site.pages.error.slug_taken")),
};

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
  }).catch((error: unknown) => ({
    conflict: transactionValidationMessageOrRethrow(error),
  }));
  if ("conflict" in outcome) {
    return { refusal: apiErrorResponse(outcome.conflict) };
  }
  if ("error" in outcome) {
    return { refusal: updateRefusal[outcome.error]() };
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

// ─── Routes ─────────────────────────────────────────────────────

export const sitePageApiRoutes: Record<string, RouteHandlerFn> = {
  "DELETE /api/admin/site-pages/:pageId": handleDelete,
  "GET /api/admin/site-pages": handleList,
  "GET /api/admin/site-pages/:pageId": handleGet,
  "POST /api/admin/site-pages": handleCreate,
  "PUT /api/admin/site-pages/:pageId": handleUpdate,
};
