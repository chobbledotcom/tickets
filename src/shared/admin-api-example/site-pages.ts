/**
 * The site-pages resource's doc entries: the five standard content-page
 * endpoints, plus the fixed pages (home, contact and terms) with their
 * refusals. The paths come from the resource table, so the docs cannot
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
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import type { DeleteBody } from "#shared/rest/crud-parsers.ts";
import {
  crudDocs,
  customRoutePath,
  type EndpointDoc,
  json,
} from "./endpoint-doc.ts";
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

/** One fixed page's answer: the page's name and its editable content, and
 *  nothing else — a fixed page has no id, slug, or Hidden flag. */
const fixedPageAnswer = (name: string, content: string): string =>
  json({ page: { content, name } });

const fixedPage = (
  customKey: keyof (typeof ADMIN_API_RESOURCES)["site-pages"]["custom"],
): string => customRoutePath(ADMIN_API_RESOURCES["site-pages"], customKey);

const homepageContent =
  "Weekend walks from the village square. Book below or just turn up.";

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
  {
    description: "Read the homepage's editable text (owners and editors)",
    method: "GET",
    path: fixedPage("homeGet"),
    response: fixedPageAnswer("home", homepageContent),
  },
  {
    description:
      "Update the homepage's editable text. The page cannot be created, deleted, or hidden.",
    method: "PUT",
    path: fixedPage("homeUpdate"),
    request: fixedPageAnswer("home", homepageContent),
    response: fixedPageAnswer("home", homepageContent),
  },
  {
    description: "Read the contact page's editable text (owners and editors)",
    method: "GET",
    path: fixedPage("contactGet"),
    response: fixedPageAnswer("contact", "Call the hut on 010 000 0000."),
  },
  {
    description:
      "Update the contact page's editable text. The page cannot be created, deleted, or hidden.",
    method: "PUT",
    path: fixedPage("contactUpdate"),
    request: fixedPageAnswer("contact", "Call the hut on 010 000 0000."),
    response: fixedPageAnswer("contact", "Call the hut on 010 000 0000."),
  },
  {
    description: "Read the terms and conditions (owner only)",
    method: "GET",
    path: fixedPage("termsGet"),
    response: fixedPageAnswer("terms", "Bookings are non-refundable."),
  },
  {
    description:
      "Update the terms and conditions. Pass an empty text to remove them (owner only). The page cannot be created, deleted, or hidden.",
    method: "PUT",
    path: fixedPage("termsUpdate"),
    request: fixedPageAnswer("terms", "Bookings are non-refundable."),
    response: fixedPageAnswer("terms", "Bookings are non-refundable."),
  },
  {
    description:
      "Refuse to create a fixed page: home, contact and terms have no row of their own, so a create on a fixed page's name answers this error.",
    method: "POST",
    path: fixedPage("homeCreate"),
    response: json({ error: "Fixed pages cannot be created." }),
  },
  {
    description: `Refuse to delete a fixed page. A fixed page's text is the only field a body may carry, capped at ${MAX_TEXTAREA_LENGTH} characters like the form's own box, and the Hidden flag is refused.`,
    method: "DELETE",
    path: fixedPage("homeDelete"),
    response: json({ error: "Fixed pages cannot be deleted." }),
  },
];
