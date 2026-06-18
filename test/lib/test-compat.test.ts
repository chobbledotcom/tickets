import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  createTestDbWithSetup,
  createTestGroup,
  deleteTestGroup,
  updateTestGroup,
  urlFromFetchInput,
} from "#test-utils";

describe("test-compat", () => {
  describe("group helpers", () => {
    test("createTestGroup uses defaults when no overrides provided", async () => {
      await createTestDbWithSetup();
      const group = await createTestGroup();
      expect(group.name).toBe("Test Group");
      expect(group.slug.length).toBe(5);
      expect(group.description).toBe("");
      expect(group.terms_and_conditions).toBe("");
    });

    test("updateTestGroup can update only the name", async () => {
      await createTestDbWithSetup();
      const group = await createTestGroup({
        name: "Before",
        slug: "update-name-group",
        termsAndConditions: "Terms",
      });
      const updated = await updateTestGroup(group.id, { name: "After" });
      expect(updated.name).toBe("After");
      expect(updated.slug).toBe("update-name-group");
      expect(updated.terms_and_conditions).toBe("Terms");
    });

    test("updateTestGroup can update only the slug", async () => {
      await createTestDbWithSetup();
      const group = await createTestGroup({
        name: "Name",
        slug: "before-slug",
        termsAndConditions: "",
      });
      const updated = await updateTestGroup(group.id, { slug: "after-slug" });
      expect(updated.name).toBe("Name");
      expect(updated.slug).toBe("after-slug");
    });

    test("updateTestGroup can update only terms_and_conditions", async () => {
      await createTestDbWithSetup();
      const group = await createTestGroup({
        name: "Name",
        slug: "terms-only",
        termsAndConditions: "",
      });
      const updated = await updateTestGroup(group.id, {
        termsAndConditions: "New terms",
      });
      expect(updated.slug).toBe("terms-only");
      expect(updated.terms_and_conditions).toBe("New terms");
    });

    test("deleteTestGroup deletes the group", async () => {
      await createTestDbWithSetup();
      const group = await createTestGroup({
        name: "Del",
        slug: "delete-group-helper",
      });
      await deleteTestGroup(group.id);
      const { groupsTable } = await import("#shared/db/groups.ts");
      expect(await groupsTable.findById(group.id)).toBeNull();
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
