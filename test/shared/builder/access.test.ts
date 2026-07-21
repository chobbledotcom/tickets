import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { siteHostingAccess } from "#shared/builder.ts";
import { describeWithEnv } from "#test-utils/db.ts";

describeWithEnv("builder hosting access", {}, () => {
  test("rejects a site with no hosting ID", () => {
    expect(
      siteHostingAccess(
        { hostingId: "", hostingProvider: "bunny" },
        "its secrets can't be read",
      ),
    ).toEqual({
      error: "This site has no hosting ID, so its secrets can't be read.",
      ok: false,
    });
  });

  test("rejects a site when its provider key is missing", () => {
    expect(
      siteHostingAccess(
        { hostingId: "42", hostingProvider: "bunny" },
        "its secrets can't be read",
      ),
    ).toEqual({
      error:
        "BUNNY_API_KEY is not configured on this host, so its secrets can't be read.",
      ok: false,
    });
  });
});
