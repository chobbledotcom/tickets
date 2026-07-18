import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { signCsrfToken } from "#shared/csrf.ts";
import { adminApiKeysPage } from "#templates/admin/api-keys.tsx";
import { setupTestEncryptionKey, withEnv } from "#test-utils/env.ts";

const SESSION = { adminLevel: "owner" as const };
const API_KEY = {
  created: "2026-07-11T10:00:00.000Z",
  id: 7,
  lastUsed: "",
  name: "Deploy key",
};

beforeAll(async () => {
  setupTestEncryptionKey();
  await signCsrfToken();
});

describe("API key pages in read-only mode", () => {
  test("hides the create form from the key list", () => {
    using _env = withEnv({ READ_ONLY_FROM: "2020-01-01T00:00:00.000Z" });
    const html = adminApiKeysPage([API_KEY], SESSION, {});
    expect(html).toContain("Deploy key");
    expect(html).not.toContain('action="/admin/api-keys"');
  });
});
