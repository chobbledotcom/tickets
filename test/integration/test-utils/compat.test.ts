import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { createTestDbWithSetup } from "#test-utils/db.ts";
import {
  createTestGroup,
  deleteTestGroup,
  updateTestGroup,
} from "#test-utils/db-helpers/groups.ts";
import { urlFromFetchInput } from "#test-utils/mocks.ts";

describe("test-compat", () => {
  describe("group helpers", () => {
    test("createTestGroup uses defaults when no overrides provided", async () => {
      await createTestDbWithSetup();
      const group = await createTestGroup();
      expect(group).toMatchObject({
        description: "",
        name: "Test Group",
        terms_and_conditions: "",
      });
      expect(group.slug.length).toBe(5);
    });

    /** One field per case: what to seed, what to change, and what must stay. */
    const updateCases = [
      {
        expected: {
          name: "After",
          slug: "update-name-group",
          terms_and_conditions: "Terms",
        },
        field: "name",
        patch: { name: "After" },
        seed: {
          name: "Before",
          slug: "update-name-group",
          termsAndConditions: "Terms",
        },
      },
      {
        expected: { name: "Name", slug: "after-slug" },
        field: "slug",
        patch: { slug: "after-slug" },
        seed: { name: "Name", slug: "before-slug", termsAndConditions: "" },
      },
      {
        expected: { slug: "terms-only", terms_and_conditions: "New terms" },
        field: "terms_and_conditions",
        patch: { termsAndConditions: "New terms" },
        seed: { name: "Name", slug: "terms-only", termsAndConditions: "" },
      },
    ];

    for (const { expected, field, patch, seed } of updateCases) {
      test(`updateTestGroup can update only the ${field}`, async () => {
        await createTestDbWithSetup();
        const group = await createTestGroup(seed);
        const updated = await updateTestGroup(group.id, patch);
        expect(updated).toMatchObject(expected);
      });
    }

    test("deleteTestGroup deletes the group", async () => {
      await createTestDbWithSetup();
      const group = await createTestGroup({
        name: "Del",
        slug: "delete-group-helper",
      });
      await deleteTestGroup(group.id);
      const { groups } = await import("#db/groups.ts");
      expect(await groups.table.read.one({ id: group.id })).toBeNull();
    });
  });

  describe("urlFromFetchInput", () => {
    test("returns string input unchanged", () => {
      expect(urlFromFetchInput("https://example.com/path")).toBe(
        "https://example.com/path",
      );
    });

    test("converts URL object to string", () => {
      const url = new URL("https://example.com/path");
      expect(urlFromFetchInput(url)).toBe("https://example.com/path");
    });

    test("extracts url from Request object", () => {
      const request = new Request("https://example.com/path");
      expect(urlFromFetchInput(request)).toBe("https://example.com/path");
    });
  });
});
