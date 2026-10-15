import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import {
  adminApiDocsPage,
  adminApiKeyDeletePage,
  adminApiKeysPage,
  apiKeySummaryRows,
} from "#templates/admin/api-keys.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";
import { tableRowContaining } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { withEnv } from "#test-utils/env.ts";
import { enableFeature } from "#test-utils/settings.ts";

const API_KEY = {
  created: "2026-07-11T10:00:00.000Z",
  id: 7,
  lastUsed: "",
  name: "Deploy key",
};

const ENDPOINT = {
  description: "Collect every listing the site offers.",
  method: "GET",
  path: "/api/listings",
  request: '{ "slug": "summer" }',
  response: '{ "listings": [] }',
};

describeWithEnv("adminApiKeyDeletePage", { db: true }, () => {
  beforeAll(setupAdminPageTest);

  test("renders the warning, confirm prompt, and dangerous submit", async () => {
    await enableFeature("apiKeys");
    const html = adminApiKeyDeletePage(API_KEY, OWNER_SESSION);

    assertStringIncludes(html, 'action="/admin/api-keys/7/delete"');
    assertStringIncludes(
      html,
      "<p>Warning: This will permanently delete this API key. Any integrations using it will stop working immediately.</p>",
    );
    assertStringIncludes(
      html,
      "<p>To delete this API key, type its name &quot;Deploy key&quot; into the box below:</p>",
    );
    assertStringIncludes(
      html,
      'name="confirm_identifier" placeholder="Deploy key" required',
    );
    assertStringIncludes(html, '<button class="danger" type="submit">');
    assertStringIncludes(html, "/icons.svg#trash-2");
    assertStringIncludes(html, "Delete API Key");
    assertStringIncludes(html, "<title>Delete: Deploy key");
    // The delete page sits in the same Users section as the list.
    assertStringIncludes(
      html,
      '<a class="active" href="/admin/users">Users</a>',
    );
  });

  test("renders a rejected-submit error", () => {
    const html = adminApiKeyDeletePage(
      API_KEY,
      OWNER_SESSION,
      "API key name does not match.",
    );

    assertStringIncludes(html, "API key name does not match.");
  });

  test("the manage page's summary rows name their label keys", () => {
    expect(apiKeySummaryRows(API_KEY)).toEqual([
      { labelKey: "common.created", value: "Saturday 11 July 2026" },
      { labelKey: "api_keys.col.last_used", value: "Never" },
    ]);
  });
});

describeWithEnv("API key pages in read-only mode", { db: true }, () => {
  beforeAll(setupAdminPageTest);

  test("hides the create form from the key list", () => {
    using _env = withEnv({ READ_ONLY_FROM: "2020-01-01T00:00:00.000Z" });
    const html = adminApiKeysPage([API_KEY], OWNER_SESSION, {});
    assertStringIncludes(html, "Deploy key");
    assert(
      !html.includes('action="/admin/api-keys"'),
      "the value should not contain the searched item",
    );
  });

  test("formats created and last-used dates consistently", () => {
    const html = adminApiKeysPage(
      [{ ...API_KEY, lastUsed: "2026-07-12T11:00:00.000Z" }],
      OWNER_SESSION,
      {},
    );

    assertStringIncludes(
      tableRowContaining(html, "Deploy key"),
      "<td>Saturday 11 July 2026</td><td>Sunday 12 July 2026</td>",
    );
  });

  test("the key table names its created and last-used columns and links each key", async () => {
    await enableFeature("apiKeys");
    const html = adminApiKeysPage([API_KEY], OWNER_SESSION, {});
    assertStringIncludes(html, "<th>Name</th>");
    assertStringIncludes(html, "<th>Created</th>");
    assertStringIncludes(html, "<th>Last used</th>");
    assertStringIncludes(html, '<a href="/admin/api-keys/7">Deploy key</a>');
    // With the feature on, the nav marks the page's Users section active.
    assertStringIncludes(
      html,
      '<a class="active" href="/admin/users">Users</a>',
    );
  });

  test("a fresh key carries its copy notice and bearer example", () => {
    const html = adminApiKeysPage([API_KEY], OWNER_SESSION, {
      newKey: "tik_live_secret",
    });
    assertStringIncludes(html, '<div class="warning">');
    assertStringIncludes(html, "Copy your API key now");
    assertStringIncludes(html, "<pre><code>tik_live_secret</code></pre>");
    assertStringIncludes(
      html,
      "<p>Use it with: <code>Authorization: Bearer YOUR_KEY</code></p>",
    );
  });

  test("the list links its docs page and its guide", () => {
    const html = adminApiKeysPage([API_KEY], OWNER_SESSION, {});
    assertStringIncludes(html, '<a href="/admin/api-keys/docs">');
    assertStringIncludes(html, 'href="/admin/guide#api"');
    assertStringIncludes(html, 'action="/admin/api-keys"');
  });
});

describe("adminApiDocsPage", () => {
  beforeAll(setupAdminPageTest);

  test("labels and code-fences each endpoint's request and response", () => {
    const html = adminApiDocsPage(OWNER_SESSION, [ENDPOINT], []);
    // The entry's summary line: method, path, dash, description.
    assertStringIncludes(
      html,
      "<code>GET /api/listings</code> — Collect every listing",
    );
    assertStringIncludes(html, "<strong>Request:</strong>");
    assertStringIncludes(
      html,
      "<pre><code>{ &quot;slug&quot;: &quot;summer&quot; }</code></pre>",
    );
    assertStringIncludes(html, "<strong>Response:</strong>");
    assertStringIncludes(
      html,
      "<pre><code>{ &quot;listings&quot;: [] }</code></pre>",
    );
  });

  test("an endpoint without a request body shows only its response", () => {
    const html = adminApiDocsPage(
      OWNER_SESSION,
      [{ ...ENDPOINT, request: "" }],
      [],
    );
    assert(
      !html.includes("Request:"),
      "the value should not contain the searched item",
    );
  });

  test("the three doc sections keep their headings and intros", () => {
    const html = adminApiDocsPage(OWNER_SESSION, [ENDPOINT], [ENDPOINT]);
    // Every docs section is a prose block, so its copy sits in .prose.
    assertStringIncludes(html, '<div class="prose"><h3>Authentication</h3>');
    assertStringIncludes(
      html,
      "Admin API endpoints require authentication via API key or session cookie:",
    );
    assertStringIncludes(html, "<h3>Public API</h3>");
    assertStringIncludes(html, "<h3>Admin API</h3>");
    assertStringIncludes(html, "Requires <code>Authorization");
    // The whole page keeps the shell's active tab and title.
    assertStringIncludes(html, "<title>API Documentation");
  });

  test("the authentication section code-fences its bearer header", () => {
    const html = adminApiDocsPage(OWNER_SESSION, [ENDPOINT], []);
    assertStringIncludes(
      html,
      "<pre><code>Authorization: Bearer YOUR_API_KEY</code></pre>",
    );
    assertStringIncludes(
      html,
      "Public API endpoints require no authentication.",
    );
  });
});
