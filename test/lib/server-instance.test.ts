/**
 * Tests for the inter-instance machine endpoint (POST /instance/site-credentials).
 *
 * The main/builder instance returns every built site's read-only DB credentials
 * to a caller holding MAIN_INSTANCE_KEY, so the upgrade workflow can back each
 * site up before deploying. Disabled (404) unless the key is set; 401 on a bad
 * key; only sites with a script id and credentials are returned.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { insertBuiltSite } from "#shared/db/built-sites.ts";
import { describeWithEnv, mockRequest, setTestEnv } from "#test-utils";

const KEY = "instance-key-0123456789abcdef0123456789abcdef";

/** POST /instance/site-credentials with optional headers. */
const post = (headers?: Record<string, string>): Promise<Response> =>
  handleRequest(
    mockRequest("/instance/site-credentials", { headers, method: "POST" }),
  );

describeWithEnv("server (instance site-credentials)", { db: true }, () => {
  test("returns 404 when MAIN_INSTANCE_KEY is not configured", async () => {
    const response = await post({ authorization: `Bearer ${KEY}` });
    expect(response.status).toBe(404);
  });

  test("returns 401 when the bearer key is missing", async () => {
    const restore = setTestEnv({ MAIN_INSTANCE_KEY: KEY });
    try {
      expect((await post()).status).toBe(401);
    } finally {
      restore();
    }
  });

  test("returns 401 when the bearer key is wrong", async () => {
    const restore = setTestEnv({ MAIN_INSTANCE_KEY: KEY });
    try {
      const response = await post({ authorization: "Bearer not-the-key" });
      expect(response.status).toBe(401);
    } finally {
      restore();
    }
  });

  test("returns read-only credentials for sites that have them", async () => {
    const restore = setTestEnv({ MAIN_INSTANCE_KEY: KEY });
    try {
      await insertBuiltSite(
        "Acme",
        "acme.b-cdn.net",
        "libsql://acme.lite.bunnydb.net",
        "ro-token-acme",
        false,
        "script-acme",
      );
      // A half-provisioned site (no script id / credentials) is omitted.
      await insertBuiltSite("Pending", "pending.b-cdn.net");

      const response = await post({ authorization: `Bearer ${KEY}` });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        sites: [
          {
            dbToken: "ro-token-acme",
            dbUrl: "libsql://acme.lite.bunnydb.net",
            name: "Acme",
            scriptId: "script-acme",
          },
        ],
      });
    } finally {
      restore();
    }
  });
});
