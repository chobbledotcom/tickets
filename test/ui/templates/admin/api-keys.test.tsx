import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import {
  adminApiKeyDeletePage,
  adminApiKeysPage,
} from "#templates/admin/api-keys.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";
import { tableRowContaining } from "#test-utils/assertions.ts";
import { withEnv } from "#test-utils/env.ts";

const API_KEY = {
  created: "2026-07-11T10:00:00.000Z",
  id: 7,
  lastUsed: "",
  name: "Deploy key",
};

describe("adminApiKeyDeletePage", () => {
  beforeAll(setupAdminPageTest);

  test("renders the warning, confirm prompt, and dangerous submit", () => {
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
  });

  test("renders a rejected-submit error", () => {
    const html = adminApiKeyDeletePage(
      API_KEY,
      OWNER_SESSION,
      "API key name does not match.",
    );

    expect(html).toContain("API key name does not match.");
  });
});

describe("API key pages in read-only mode", () => {
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
});
