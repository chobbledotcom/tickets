// Behaviour pins for the attribute resource, taken before the API/page
// unification layers. Each test fixes what one surface answers today, so the
// layer that moves the attribute input mapping into a shared core (and fixes
// #2476 in the shared update parser) can prove both surfaces unchanged. Both
// surfaces are owner-only. The page posts to /admin/attributes; the JSON API
// posts to /api/admin/attributes (OWNER_API).
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getAllAttributesWithOptions } from "#db/attributes.ts";
import { assertJson } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestManagerSession } from "#test-utils/session.ts";
import {
  managerApiPost,
  ownerApiPost,
  ownerApiPut,
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
    expect([200, 302]).toContain(response.status);
    const row = await storedAttribute("Pinned Page Attribute");
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

  // The attributes surface already rejects a non-string name before the shared
  // parser runs (issue #2476 records the shared defect). L3 moves that guard
  // into the core; this pin is the behaviour the move must preserve.
  test("api update rejects a non-string name with 400", async () => {
    const created = await assertJson<{ attribute: { id: number } }>(
      ownerApiPost("/api/admin/attributes", {
        name: "Pinned Guard Attribute",
      }),
      201,
    );
    await assertJson(
      ownerApiPut(`/api/admin/attributes/${created.attribute.id}`, {
        name: 123,
      }),
      400,
      (body) => {
        expect(body.error).toBe("name must be a string");
      },
    );
  });

  test("a manager is refused on both surfaces", async () => {
    const managerCookie = await createTestManagerSession();
    const api = await managerApiPost(
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
