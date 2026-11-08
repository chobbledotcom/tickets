import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import { adminApiRoutes } from "#routes/admin/api.ts";
import { ADMIN_API_RESOURCES } from "#shared/admin-api-resources.ts";
import {
  API_BOOK_FREE_EXAMPLE_JSON,
  API_BOOK_PAID_EXAMPLE_JSON,
} from "#shared/api-example.ts";
import {
  ExampleCode,
  renderGuideSections,
} from "#templates/admin/guide/components.tsx";
import {
  integrationsSections,
  PricedJsonExample,
} from "#templates/admin/guide/integrations.tsx";
import { expectIncludesAll } from "#test-utils/assertions.ts";

/** What a `<code>` body shows: JSX escapes double quotes as entities. */
const shown = (code: string): string => code.replaceAll('"', "&quot;");

/** The answers that describe the admin JSON API. External sources have their
 *  own section, and the two answers together must cover the resource table. */
const ADMIN_API_ANSWERS = [
  "what_admin_endpoints_are_available",
  "external_sources_api",
] as const;

const adminApiAnswer = (): string =>
  ADMIN_API_ANSWERS.map((id) => t(`guide.a.${id}`)).join("");

/** One path with every parameter name flattened, so the guide's generic `:id`
 *  and the table's resource-named `:listingId` compare equal. */
const flatParams = (path: string): string =>
  path.replace(/:[A-Za-z0-9_]+/g, ":id");

/** Every path the admin route table serves, parameter names flattened. */
const servedPaths = (): Set<string> =>
  new Set(
    Object.keys(adminApiRoutes).map((route) =>
      flatParams(route.slice(route.indexOf(" ") + 1)),
    ),
  );

/** Every `/api/admin` path one answer names, with the query string dropped. The
 *  two generalised forms (`/api/admin/<name>` and its `:id` form) name no one
 *  resource, so they are not paths a route serves. */
const namedPaths = (answer: string): string[] => [
  ...new Set(
    [...answer.matchAll(/\/api\/admin\/[^"'\s<&]*/g)]
      .map((match) => match[0].split("?")[0]!)
      .filter((path) => path !== "/api/admin/")
      .map(flatParams),
  ),
];

describe("guide integrations section", () => {
  test("the booking example answers are labelled and code-fenced", () => {
    const html = String(renderGuideSections(integrationsSections()));
    expectIncludesAll(html, [
      "<p><strong>Free listing response:</strong></p>",
      `<pre><code>${shown(API_BOOK_FREE_EXAMPLE_JSON)}</code></pre>`,
      "<p><strong>Paid listing response:</strong></p>",
      `<pre><code>${shown(API_BOOK_PAID_EXAMPLE_JSON)}</code></pre>`,
    ]);
  });

  test("PricedJsonExample code-fences its JSON, then notes the currency unit", () => {
    const html = String(
      PricedJsonExample({
        children: <>Amounts include the booking fee.</>,
        json: API_BOOK_FREE_EXAMPLE_JSON,
      }),
    );
    expectIncludesAll(html, [
      `<pre><code>${shown(API_BOOK_FREE_EXAMPLE_JSON)}</code></pre>`,
      "smallest currency unit (e.g. pence for GBP",
      "Amounts include the booking fee.",
    ]);
  });

  test("ExampleCode pairs a bold label with its code block", () => {
    const html = String(
      <ExampleCode code='{"a":1}' label="Free listing response:" />,
    );
    assertStringIncludes(
      html,
      `<p><strong>Free listing response:</strong></p><pre><code>${shown('{"a":1}')}</code></pre>`,
    );
  });

  test("the guide's links, anchors, and inline-code joins stay intact", () => {
    const html = String(renderGuideSections(integrationsSections()));
    // Links the sections are reachable through.
    expectIncludesAll(html, [
      '<a href="https://sms-gate.app">',
      '<a href="https://mobilizon.org/">',
      '<a href="https://import.mobilizon.fr/">',
      '<a href="/admin/settings-advanced#settings-sms-gateway">',
      '<a href="/admin/log">',
      // The anchor ids the guide's own footer deep-links use.
      '<h3 id="sms">',
      '<h3 id="api">',
      '<h3 id="admin-api">',
      // The joins between prose and its inline code: exactly one space each.
      "the public importer at <a href=",
      "Enter your calendar feed address: <code>https://",
      "works with the free <a href=",
      "Message text and phone numbers are <strong>end-to-end",
      "shows you a <strong>username and password</strong>",
      "recorded in the <a href=",
      "The starting address is your own site address (for example <code>https://",
      "Returns <code>{ &quot;error&quot;: &quot;Listing not found&quot; }</code> with status 404",
      // The app link join: the link text and the following word share one space.
      ">SMS Gateway for Android</a> app: install the app",
      // The settings link begins its list item with one space after "In".
      "In <a href=",
      // The wrapped availability code block joins its dash with one space too.
      "date=YYYY-MM-DD</code> — check whether places are free",
      // The daily-listing parameter note joins its inline code the same way.
      "For daily listings, add <code>&amp;date=YYYY-MM-DD</code> to check",
      "(use a date from <code>availableDates</code>)",
    ]);
  });

  test("names the same paths the admin API route table serves", () => {
    const named = namedPaths(adminApiAnswer());
    const roots = Object.values(ADMIN_API_RESOURCES).map(
      (resource) => `/api/admin/${resource.path}`,
    );
    // The extractor reads every resource root the table declares, so the check
    // below cannot pass on an empty reading.
    expect(named.filter((path) => roots.includes(path)).toSorted()).toEqual(
      roots.toSorted(),
    );
    const served = servedPaths();
    expect(named.filter((path) => !served.has(path))).toEqual([]);
  });

  test("the Admin API answer links its own section", () => {
    expectIncludesAll(adminApiAnswer(), [
      '<a href="#external-sources">External sources</a>',
    ]);
  });
});
