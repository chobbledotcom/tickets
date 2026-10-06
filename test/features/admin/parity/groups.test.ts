// Behaviour pins for the group resource: what each surface answers today,
// one test per fact. The page posts to /admin/groups; the JSON API posts to
// /api/admin/groups (CONTENT_API: owner, manager, editor).
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getGroupPackagePrices, groups } from "#db/groups.ts";
import { assertJson, expectRedirectWithFlash } from "#test-utils/assertions.ts";
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
    const response = await ownerPagePost("/admin/groups", {
      description: "Pinned page group",
      max_attendees: "0",
      name: "Pinned Page Group",
    });
    expect(response.status).toBe(302);
    const row = await storedGroup("Pinned Page Group");
    expect(row.description).toBe("Pinned page group");
    expect(row.hidden).toBe(false);
    expect(row.is_package).toBe(false);
    expect(row.max_attendees).toBe(0);
    // An absent checkbox stores false, while the API's column default for
    // show_hidden_listings is true.
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
  // malformed one fails closed with a field-named message.
  test("api update parses a well-formed package member", async () => {
    const created = await assertJson<{ group: { id: number } }>(
      ownerApiPost("/api/admin/groups", {
        is_package: true,
        name: "Pinned Package Group",
      }),
      201,
    );
    const listed = await createTestListing({
      groupId: created.group.id,
      name: "Pinned Package Member",
    });
    await assertJson(
      ownerApiPut(`/api/admin/groups/${created.group.id}`, {
        package_members: [{ listing_id: listed.id, price: 5000 }],
      }),
      200,
      (body) => {
        expect(body.group.is_package).toBe(true);
      },
    );
    // The update must have stored the member: the row carries the listing,
    // the minor-unit price, and the default quantity of one.
    const member = await getGroupPackagePrices(created.group.id);
    expect(member).toHaveLength(1);
    expect(member[0]?.listing_id).toBe(listed.id);
    expect(member[0]?.package_price).toBe(5000);
    expect(member[0]?.quantity).toBe(1);
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

    // The page redirects back to the confirmation page with the mismatch in
    // the flash; the API answers 400 in JSON with the same refusal. Both keep
    // the row.
    const page = await ownerPagePost(`/admin/groups/${row.id}/delete`, {
      confirm_identifier: "Wrong Name",
    });
    expectRedirectWithFlash(
      `/admin/groups/${row.id}/delete`,
      "Group name does not match. Please type the exact group name to confirm deletion.",
      false,
    )(page);
    expect(
      (await groups.cache.getAll()).find((g) => g.id === row.id),
    ).toBeDefined();

    const api = await ownerApiDelete(`/api/admin/groups/${row.id}`, {
      confirm_identifier: "Wrong Name",
    });
    expect(api.status).toBe(400);
    expect((await api.json()).error).toBe(
      "Group name does not match. Please provide the exact group name in confirm_identifier.",
    );
    expect(
      (await groups.cache.getAll()).find((g) => g.id === row.id),
    ).toBeDefined();
  });
});
