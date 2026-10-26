/**
 * The site-pages resource's doc entries: the five standard content-page
 * endpoints plus the fixed pages (home, contact and terms) read and updated
 * by name. The paths come from the resource table, so the docs cannot
 * disagree with the server about them.
 */

// jscpd:ignore-start
import type {
  CreateSitePageBody,
  UpdateSitePageBody,
} from "#routes/admin/api-site-pages-input.ts";
import {
  ADMIN_API_RESOURCES,
  type AdminApiSitePage,
} from "#shared/admin-api-resources.ts";
import type { DeleteBody } from "#shared/rest/crud-parsers.ts";
import { crudDocs, type EndpointDoc, json } from "./endpoint-doc.ts";
// jscpd:ignore-end

/** One content page exactly as the admin endpoints answer with it: the
 *  stored row plus the page it nests under (null at the top level). */
export const ADMIN_API_EXAMPLE_SITE_PAGE = {
  content: "Pack light. The hut takes cash only.",
  hidden: false,
  id: 3,
  meta_description: "Everything to know before the weekend",
  meta_title: "Plan your weekend",
  name: "Plan your weekend",
  parent: null,
  slug: "plan-your-weekend",
} satisfies AdminApiSitePage;

const CREATE_SITE_PAGE_BODY: CreateSitePageBody = {
  content: ADMIN_API_EXAMPLE_SITE_PAGE.content,
  hidden: ADMIN_API_EXAMPLE_SITE_PAGE.hidden,
  meta_description: ADMIN_API_EXAMPLE_SITE_PAGE.meta_description,
  meta_title: ADMIN_API_EXAMPLE_SITE_PAGE.meta_title,
  name: ADMIN_API_EXAMPLE_SITE_PAGE.name,
  slug: ADMIN_API_EXAMPLE_SITE_PAGE.slug,
};

const UPDATE_SITE_PAGE_BODY: UpdateSitePageBody = {
  hidden: true,
};

const SITE_PAGE_DELETE_BODY: DeleteBody = {
  confirm_identifier: ADMIN_API_EXAMPLE_SITE_PAGE.name,
};

/** The content a fixed-page read or update answers with. The home, contact,
 *  and terms pages share the shape: their name plus this body text. */
const FIXED_PAGE_CONTENT = "Welcome to the hut. The hill is open all year.";

/** One documented fixed-page route. The path and the page shape are shared
 *  across the three names and the read, update, and refusal verbs. */
const fixedPageDoc = (
  name: "contact" | "home" | "terms",
  method: "DELETE" | "GET" | "POST" | "PUT",
  description: string,
  response: unknown,
  request?: unknown,
): EndpointDoc => ({
  description,
  method,
  path: `/api/admin/site-pages/${name}`,
  ...(request === undefined ? {} : { request: json(request) }),
  response: json(response),
});

export const SITE_PAGE_ENDPOINTS: EndpointDoc[] = [
  ...crudDocs({
    createBody: CREATE_SITE_PAGE_BODY,
    deleteBody: SITE_PAGE_DELETE_BODY,
    desc: [
      "List all site pages with their parent page (owners and editors)",
      "Get a single site page by ID (owners and editors)",
      "Create a site page. The new page is a top-level page (owners and editors)",
      "Update a site page (all fields optional; parent takes a page id, or null to move the page to the top level)",
      "Delete a site page (owners and editors, requires name confirmation)",
    ],
    entry: ADMIN_API_RESOURCES["site-pages"],
    example: ADMIN_API_EXAMPLE_SITE_PAGE,
    listResponse: { "site-pages": [ADMIN_API_EXAMPLE_SITE_PAGE] },
    singular: "page",
    updateBody: UPDATE_SITE_PAGE_BODY,
  }),
  // The three fixed pages: home, contact and terms. Each is read and its
  // content updated by name, and cannot be created, deleted, or hidden.
  ...(["home", "contact", "terms"] as const).flatMap((name) => [
    fixedPageDoc(name, "GET", `Read the ${name} page (owners and editors)`, {
      page: { content: FIXED_PAGE_CONTENT, name },
    }),
    fixedPageDoc(
      name,
      "PUT",
      `Update the ${name} page's content (owners and editors)`,
      { page: { content: FIXED_PAGE_CONTENT, name } },
      { content: FIXED_PAGE_CONTENT },
    ),
    fixedPageDoc(
      name,
      "POST",
      "A fixed page cannot be created (owners and editors)",
      { error: "fixed pages cannot be created" },
    ),
    fixedPageDoc(
      name,
      "DELETE",
      "A fixed page cannot be deleted (owners and editors)",
      { error: "fixed pages cannot be deleted" },
    ),
  ]),
];
