import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { adminApiKeysPage } from "#templates/admin/api-keys.tsx";
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
