import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  assignBuiltSite,
  builtSites,
  builtSitesCrudTable,
  getAssignableBuiltSites,
  getBuiltSiteByRenewalTokenIndex,
  insertBuiltSite,
  parseSiteDataBlob,
  updateBuiltSiteRenewalState,
} from "#shared/db/built-sites.ts";
import { describeWithEnv } from "#test-utils/db.ts";

describeWithEnv("assignable built sites", { db: true }, () => {
  test("insertBuiltSite stores the assignable flag", async () => {
    await insertBuiltSite("Assignable Site", "a.b-cdn.net", "", "", true);
    expect((await builtSites.getAll())[0]?.assignable).toBe(true);
  });

  test("insertBuiltSite defaults to not assignable", async () => {
    await insertBuiltSite("Default Site", "d.b-cdn.net");
    expect((await builtSites.getAll())[0]?.assignable).toBe(false);
  });

  test("getAssignableBuiltSites filters to assignable sites", async () => {
    await insertBuiltSite("Site A", "a.b-cdn.net", "", "", true);
    await insertBuiltSite("Site B", "b.b-cdn.net", "", "", false);
    await insertBuiltSite("Site C", "c.b-cdn.net", "", "", true);
    expect((await getAssignableBuiltSites()).map(({ name }) => name)).toEqual([
      "Site A",
      "Site C",
    ]);
  });

  test("assignBuiltSite stores the assignment", async () => {
    const row = await insertBuiltSite(
      "To Assign",
      "assign.b-cdn.net",
      "",
      "",
      true,
    );
    expect(await assignBuiltSite(row.id, 42, 7)).toMatchObject({
      assignable: false,
      assignedAttendeeId: 42,
      assignedListingId: 7,
    });
  });

  test("assignBuiltSite returns null for a missing site", async () => {
    expect(await assignBuiltSite(999, 1, 1)).toBeNull();
  });

  test("unassigned sites have null assignment ids", async () => {
    await insertBuiltSite("Unassigned", "u.b-cdn.net", "", "", true);
    expect((await builtSites.getAll())[0]).toMatchObject({
      assignedAttendeeId: null,
      assignedListingId: null,
    });
  });
});

describeWithEnv("built-site renewal storage", { db: true }, () => {
  test("new sites have empty renewal state", async () => {
    await insertBuiltSite("Renewal Site", "renewal.b-cdn.net");
    expect((await builtSites.getAll())[0]).toMatchObject({
      readOnlyFrom: "",
      renewalToken: null,
      renewalTokenIndex: null,
    });
  });

  test("getBuiltSiteByRenewalTokenIndex returns the matching site", async () => {
    const row = await insertBuiltSite("Token Site", "token.b-cdn.net");
    await updateBuiltSiteRenewalState(row.id, {
      readOnlyFrom: "2026-07-01T00:00:00Z",
      renewalToken: "raw-token-123",
      renewalTokenIndex: "test-index-abc",
    });
    expect(
      await getBuiltSiteByRenewalTokenIndex("test-index-abc"),
    ).toMatchObject({
      name: "Token Site",
      readOnlyFrom: "2026-07-01T00:00:00Z",
    });
  });

  test("getBuiltSiteByRenewalTokenIndex returns null when no site matches", async () => {
    expect(await getBuiltSiteByRenewalTokenIndex("nonexistent")).toBeNull();
  });

  test("multiple sites may have a null renewal index", async () => {
    await insertBuiltSite("Site 1", "s1.b-cdn.net");
    await insertBuiltSite("Site 2", "s2.b-cdn.net");
    expect(
      (await builtSites.getAll())
        .filter(({ renewalTokenIndex }) => renewalTokenIndex === null)
        .map(({ name }) => name),
    ).toEqual(["Site 1", "Site 2"]);
  });

  test("legacy blobs omit the renewal token", () => {
    const parsed = parseSiteDataBlob(
      JSON.stringify({ n: "Old Site", u: "old.b-cdn.net", v: 1 }),
    );
    expect(parsed.rt).toBeUndefined();
  });

  test("CRUD edits preserve renewal state", async () => {
    const site = await builtSitesCrudTable.insert({
      assignable: false,
      dbToken: "",
      dbUrl: "",
      hostingId: "100",
      name: "Token Preserve",
      siteUrl: "preserve.b-cdn.net",
    });
    await updateBuiltSiteRenewalState(site.id, {
      readOnlyFrom: "2026-08-01T00:00:00Z",
      renewalToken: "secret-token",
      renewalTokenIndex: "idx-123",
    });
    expect(
      await builtSitesCrudTable.update(site.id, {
        name: "Token Preserve Updated",
      }),
    ).toMatchObject({
      name: "Token Preserve Updated",
      readOnlyFrom: "2026-08-01T00:00:00Z",
      renewalToken: "secret-token",
      renewalTokenIndex: "idx-123",
    });
  });

  test("updateBuiltSiteRenewalState updates selected fields", async () => {
    const row = await insertBuiltSite("Renewal Update", "ru.b-cdn.net");
    await updateBuiltSiteRenewalState(row.id, {
      readOnlyFrom: "2027-01-01T00:00:00Z",
    });
    await updateBuiltSiteRenewalState(row.id, {
      renewalToken: "tok-456",
      renewalTokenIndex: "idx-456",
    });
    expect(await getBuiltSiteByRenewalTokenIndex("idx-456")).toMatchObject({
      readOnlyFrom: "2027-01-01T00:00:00Z",
      renewalToken: "tok-456",
      renewalTokenIndex: "idx-456",
    });
  });

  test("an empty renewal index remains an empty string", async () => {
    const row = await insertBuiltSite("Empty Index", "empty-index.b-cdn.net");
    await updateBuiltSiteRenewalState(row.id, { renewalTokenIndex: "" });
    expect(
      (await builtSitesCrudTable.findById(row.id))?.renewalTokenIndex,
    ).toBe("");
  });

  test("an empty renewal token clears the stored token", async () => {
    const row = await insertBuiltSite("Empty Token", "empty-token.b-cdn.net");
    await updateBuiltSiteRenewalState(row.id, {
      renewalToken: "stored-token",
    });

    await updateBuiltSiteRenewalState(row.id, { renewalToken: "" });

    expect(
      (await builtSitesCrudTable.findById(row.id))?.renewalToken,
    ).toBeNull();
  });
});
