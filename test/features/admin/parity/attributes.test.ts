// Behaviour pins for the attribute resource: what each surface answers
// today, one test per fact. The page posts to /admin/attributes; the JSON API
// posts to /api/admin/attributes (OWNER_API). Both surfaces are owner-only.
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getAllAttributesWithOptions } from "#db/attributes.ts";
import { assertJson, expectRedirectWithFlash } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestManagerSession } from "#test-utils/session.ts";
import {
  apiPostAs,
  expectNonStringNameRefused,
  ownerApiPost,
  ownerPagePost,
  pagePostAs,
} from "./helpers.ts";

describeWithEnv("Attribute parity pins", { db: true }, () => {
  const storedAttribute = async (name: string) => {
    const all = await getAllAttributesWithOptions();
    const row = all.find((a) => a.name === name);
    if (!row) throw new Error(`no attribute named ${name} was stored`);
    return row;
  };

  test("page create stores the posted name", async () => {
    const response = await ownerPagePost("/admin/attributes", {
      name: "Pinned Page Attribute",
    });
    const row = await storedAttribute("Pinned Page Attribute");
    expectRedirectWithFlash(
      `/admin/attributes/${row.id}`,
      "Attribute created",
    )(response);
    expect(row.name).toBe("Pinned Page Attribute");
  });

  test("api create stores the posted name", async () => {
    await assertJson(
      ownerApiPost("/api/admin/attributes", {
        name: "Pinned Api Attribute",
      }),
      201,
      (body) => {
        expect(body.attribute.name).toBe("Pinned Api Attribute");
      },
    );
  });

  // The attributes API answers a non-string name with the field-named 400
  // before the shared parser runs (issue #2476 records the shared defect).
  test("api update rejects a non-string name with 400", async () => {
    await expectNonStringNameRefused("attributes", "attribute", {
      name: "Pinned Guard Attribute",
    });
  });

  test("a manager is refused on both surfaces", async () => {
    const managerCookie = await createTestManagerSession();
    const api = await apiPostAs(
      "/api/admin/attributes",
      { name: "Manager Api Attribute" },
      managerCookie,
    );
    expect(api.status).toBe(403);

    // A valid CSRF token, so the 403 is the role gate, not a token failure.
    const page = await pagePostAs(
      "/admin/attributes",
      { name: "Manager Page Attribute" },
      managerCookie,
    );
    expect(page.status).toBe(403);
  });
});
