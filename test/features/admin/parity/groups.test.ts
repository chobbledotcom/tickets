// Behaviour pins for the group resource, taken before the API/page unification
// layers. Each test fixes what one surface answers today, so the layer that
// moves package-member parsing into the shared core can prove both surfaces
// unchanged. The page posts to /admin/groups; the JSON API posts to
// /api/admin/groups (CONTENT_API: owner, manager, editor).
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { groups } from "#db/groups.ts";
import { assertJson } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  ownerApiDelete,
  ownerApiPost,
  ownerApiPut,
  ownerPagePost,
} from "./helpers.ts";

describeWithEnv("Group parity pins", { db: true }, () => {
  const storedGroup = async (name: string) => {
    const all = await groups.cache.getAll();
    const row = all.find((g) => g.name === name);
    if (!row) throw new Error(`no group named ${name} was stored`);
    return row;
  };

  test("page create stores the posted fields, absent checkboxes off", async () => {
    await ownerPagePost("/admin/groups", {
      description: "Pinned page group",
      max_attendees: "0",
      name: "Pinned Page Group",
    });
    const row = await storedGroup("Pinned Page Group");
    expect(row.description).toBe("Pinned page group");
    expect(row.hidden).toBe(false);
    expect(row.is_package).toBe(false);
    expect(row.max_attendees).toBe(0);
    // An absent checkbox stores false, while the API's column default for
    // show_hidden_listings is true. Current behaviour, recorded for the
    // unification layers to reconcile.
    expect(row.show_hidden_listings).toBe(false);
  });

  test("api create stores the same shape from the same facts", async () => {
    await assertJson(
      ownerApiPost("/api/admin/groups", {
        description: "Pinned api group",
        max_attendees: 0,
        name: "Pinned Api Group",
      }),
      201,
      (body) => {
        expect(body.group.hidden).toBe(false);
        expect(body.group.is_package).toBe(false);
        expect(body.group.show_hidden_listings).toBe(true);
      },
    );
  });

  // Current package-member body parsing on the API side: members are
  // update-only (create refuses them), a well-formed entry is accepted, and a
  // malformed one fails closed with a field-named message. L4 reworks this
  // parsing and restates these pins.
  test("api update parses a well-formed package member", async () => {
    const created = await assertJson<{ group: { id: number } }>(
      ownerApiPost("/api/admin/groups", {
        is_package: true,
        name: "Pinned Package Group",
      }),
      201,
    );
    const listed = await createTestListing({ name: "Pinned Package Member" });
    await assertJson(
      ownerApiPut(`/api/admin/groups/${created.group.id}`, {
        package_members: [{ listing_id: listed.id, price: 5000 }],
      }),
      200,
      (body) => {
        expect(body.group.is_package).toBe(true);
      },
    );
  });

  test("api create refuses package members outright", async () => {
    await assertJson(
      ownerApiPost("/api/admin/groups", {
        is_package: true,
        name: "Pinned Bad Member Group",
        package_members: [{ listing_id: 1 }],
      }),
      400,
      (body) => {
        expect(body.error).toBe(
          "package_members cannot be set on create; create the group, assign listings, then update it",
        );
      },
    );
  });

  test("both surfaces refuse a delete whose confirmation does not match", async () => {
    await ownerPagePost("/admin/groups", {
      max_attendees: "0",
      name: "Pinned Delete Group",
    });
    const row = await storedGroup("Pinned Delete Group");

    // The page redirects back with the mismatch in the flash; the API answers
    // 400 in JSON. Both keep the row.
    const page = await ownerPagePost(`/admin/groups/${row.id}/delete`, {
      confirm_identifier: "Wrong Name",
    });
    expect(page.status).toBe(302);
    expect(
      (await groups.cache.getAll()).find((g) => g.id === row.id),
    ).toBeDefined();

    const api = await ownerApiDelete(`/api/admin/groups/${row.id}`, {
      confirm_identifier: "Wrong Name",
    });
    expect(api.status).toBe(400);
    expect(
      (await groups.cache.getAll()).find((g) => g.id === row.id),
    ).toBeDefined();
  });
});
