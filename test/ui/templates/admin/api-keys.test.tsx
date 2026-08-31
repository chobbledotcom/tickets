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

    expect(html).toContain('action="/admin/api-keys/7/delete"');
    expect(html).toContain(
      "<p>Warning: This will permanently delete this API key. Any integrations using it will stop working immediately.</p>",
    );
    expect(html).toContain(
      "<p>To delete this API key, type its name &quot;Deploy key&quot; into the box below:</p>",
    );
    expect(html).toContain(
      'name="confirm_identifier" placeholder="Deploy key" required',
    );
    expect(html).toContain('<button class="danger" type="submit">');
    expect(html).toContain("/icons.svg#trash-2");
    expect(html).toContain("Delete API Key");
    expect(html).toContain("<title>Delete: Deploy key");
    // The delete page sits in the same Users section as the list.
    expect(html).toContain('<a class="active" href="/admin/users">Users</a>');
  });

  test("renders a rejected-submit error", () => {
    const html = adminApiKeyDeletePage(
      API_KEY,
      OWNER_SESSION,
      "API key name does not match.",
    );

    expect(html).toContain("API key name does not match.");
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
    expect(html).toContain("Deploy key");
    expect(html).not.toContain('action="/admin/api-keys"');
  });

  test("formats created and last-used dates consistently", () => {
    const html = adminApiKeysPage(
      [{ ...API_KEY, lastUsed: "2026-07-12T11:00:00.000Z" }],
      OWNER_SESSION,
      {},
    );

    expect(tableRowContaining(html, "Deploy key")).toContain(
      "<td>Saturday 11 July 2026</td><td>Sunday 12 July 2026</td>",
    );
  });

  test("the key table names its created and last-used columns and links each key", async () => {
    await enableFeature("apiKeys");
    const html = adminApiKeysPage([API_KEY], OWNER_SESSION, {});
    expect(html).toContain("<th>Name</th>");
    expect(html).toContain("<th>Created</th>");
    expect(html).toContain("<th>Last used</th>");
    expect(html).toContain('<a href="/admin/api-keys/7">Deploy key</a>');
    // With the feature on, the nav marks the page's Users section active.
    expect(html).toContain('<a class="active" href="/admin/users">Users</a>');
  });

  test("a fresh key carries its copy notice and bearer example", () => {
    const html = adminApiKeysPage([API_KEY], OWNER_SESSION, {
      newKey: "tik_live_secret",
    });
    expect(html).toContain('<div class="warning">');
    expect(html).toContain("Copy your API key now");
    expect(html).toContain("<pre><code>tik_live_secret</code></pre>");
    expect(html).toContain(
      "<p>Use it with: <code>Authorization: Bearer YOUR_KEY</code></p>",
    );
  });

  test("the list links its docs page and its guide", () => {
    const html = adminApiKeysPage([API_KEY], OWNER_SESSION, {});
    expect(html).toContain('<a href="/admin/api-keys/docs">');
    expect(html).toContain('href="/admin/guide#api"');
    expect(html).toContain('action="/admin/api-keys"');
  });
});

describe("adminApiDocsPage", () => {
  beforeAll(setupAdminPageTest);

  test("labels and code-fences each endpoint's request and response", () => {
    const html = adminApiDocsPage(OWNER_SESSION, [ENDPOINT], []);
    // The entry's summary line: method, path, dash, description.
    expect(html).toContain(
      "<code>GET /api/listings</code> — Collect every listing",
    );
    expect(html).toContain("<strong>Request:</strong>");
    expect(html).toContain(
      "<pre><code>{ &quot;slug&quot;: &quot;summer&quot; }</code></pre>",
    );
    expect(html).toContain("<strong>Response:</strong>");
    expect(html).toContain(
      "<pre><code>{ &quot;listings&quot;: [] }</code></pre>",
    );
  });

  test("an endpoint without a request body shows only its response", () => {
    const html = adminApiDocsPage(
      OWNER_SESSION,
      [{ ...ENDPOINT, request: "" }],
      [],
    );
    expect(html).not.toContain("Request:");
  });

  test("the three doc sections keep their headings and intros", () => {
    const html = adminApiDocsPage(OWNER_SESSION, [ENDPOINT], [ENDPOINT]);
    // Every docs section is a prose block, so its copy sits in .prose.
    expect(html).toContain('<div class="prose"><h3>Authentication</h3>');
    expect(html).toContain(
      "Admin API endpoints require authentication via API key or session cookie:",
    );
    expect(html).toContain("<h3>Public API</h3>");
    expect(html).toContain("<h3>Admin API</h3>");
    expect(html).toContain("Requires <code>Authorization");
    // The whole page keeps the shell's active tab and title.
    expect(html).toContain("<title>API Documentation");
  });

  test("the authentication section code-fences its bearer header", () => {
    const html = adminApiDocsPage(OWNER_SESSION, [ENDPOINT], []);
    expect(html).toContain(
      "<pre><code>Authorization: Bearer YOUR_API_KEY</code></pre>",
    );
    expect(html).toContain("Public API endpoints require no authentication.");
  });
});
