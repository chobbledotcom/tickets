import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  assignBuiltSite,
  builtSitesCrudTable,
  claimNextBuiltSiteForPrune,
  DEFAULT_UPDATE_TIER,
  getAllBuiltSites,
  getAssignableBuiltSites,
  getBuiltSiteByRenewalTokenIndex,
  insertBuiltSite,
  isUpdateTier,
  parseSiteDataBlob,
  siteAcceptsDeployTier,
  siteBaseUrl,
  UPDATE_TIERS,
  updateBuiltSiteRenewalState,
} from "#shared/db/built-sites.ts";
import { describeWithEnv } from "#test-utils";

const formBlob = async (
  input: Parameters<typeof builtSitesCrudTable.toDbValues>[0],
) => {
  const values = await builtSitesCrudTable.toDbValues(input);
  return parseSiteDataBlob(values.site_data as string);
};

describe("siteBaseUrl", () => {
  test("prepends https:// to a bare hostname", () => {
    expect(siteBaseUrl("site.b-cdn.net")).toBe("https://site.b-cdn.net");
  });

  test("keeps an existing scheme", () => {
    expect(siteBaseUrl("http://example.com")).toBe("http://example.com");
  });

  test("strips a trailing slash so a path can be appended", () => {
    expect(siteBaseUrl("https://example.com/")).toBe("https://example.com");
  });

  test("collapses a path, query, and hash to the origin", () => {
    expect(siteBaseUrl("https://example.com/admin?x=1#y")).toBe(
      "https://example.com",
    );
  });

  test("normalizes an uppercase scheme to a lowercase origin", () => {
    expect(siteBaseUrl("HTTPS://example.com")).toBe("https://example.com");
  });
});

describe("update tiers", () => {
  test("UPDATE_TIERS is ordered most- to least-eager", () => {
    expect(UPDATE_TIERS).toEqual(["alpha", "beta", "release"]);
  });

  test("DEFAULT_UPDATE_TIER is the most conservative channel", () => {
    expect(DEFAULT_UPDATE_TIER).toBe("release");
  });

  test("isUpdateTier accepts known channels and rejects anything else", () => {
    for (const tier of UPDATE_TIERS) expect(isUpdateTier(tier)).toBe(true);
    for (const bad of ["", "ALPHA", "stable", "rel", "release "]) {
      expect(isUpdateTier(bad)).toBe(false);
    }
  });

  test("a release deploy reaches every channel", () => {
    for (const siteTier of UPDATE_TIERS) {
      expect(siteAcceptsDeployTier(siteTier, "release")).toBe(true);
    }
  });

  test("a beta deploy reaches beta + alpha sites but not release-only", () => {
    expect(siteAcceptsDeployTier("alpha", "beta")).toBe(true);
    expect(siteAcceptsDeployTier("beta", "beta")).toBe(true);
    expect(siteAcceptsDeployTier("release", "beta")).toBe(false);
  });

  test("an alpha deploy reaches only alpha sites", () => {
    expect(siteAcceptsDeployTier("alpha", "alpha")).toBe(true);
    expect(siteAcceptsDeployTier("beta", "alpha")).toBe(false);
    expect(siteAcceptsDeployTier("release", "alpha")).toBe(false);
  });
});

describeWithEnv("claimNextBuiltSiteForPrune", { db: true }, () => {
  test("returns null when there are no built sites", async () => {
    expect(await claimNextBuiltSiteForPrune()).toBe(null);
  });

  test("walks sites least-recently-pruned first, then round-robins", async () => {
    await insertBuiltSite("A", "a.example.com");
    await insertBuiltSite("B", "b.example.com");

    // Both start never-pruned (''), so the lowest id goes first; after each is
    // stamped, the other (still '') is next; then it cycles back to the oldest.
    const first = await claimNextBuiltSiteForPrune();
    const second = await claimNextBuiltSiteForPrune();
    const third = await claimNextBuiltSiteForPrune();

    expect(first?.siteUrl).toBe("a.example.com");
    expect(second?.siteUrl).toBe("b.example.com");
    expect(third?.siteUrl).toBe("a.example.com");
  });
});

describeWithEnv("built-sites", { db: true }, () => {
  test("toDbValues creates valid site-data JSON", async () => {
    const parsed = await formBlob({
      name: "Test Site",
      siteUrl: "test.b-cdn.net",
    });
    expect(parsed.n).toBe("Test Site");
    expect(parsed.u).toBe("test.b-cdn.net");
    expect(parsed.v).toBe(1);
  });

  test("toDbValues includes db credentials when provided", async () => {
    const parsed = await formBlob({
      dbToken: "secret-token",
      dbUrl: "libsql://db.turso.io",
      name: "Test Site",
      siteUrl: "test.b-cdn.net",
    });
    expect(parsed.d).toBe("libsql://db.turso.io");
    expect(parsed.t).toBe("secret-token");
  });

  test("toDbValues omits db keys when empty", async () => {
    const parsed = await formBlob({
      name: "Test Site",
      siteUrl: "test.b-cdn.net",
    });
    expect(parsed.d).toBeUndefined();
    expect(parsed.t).toBeUndefined();
  });

  test("toDbValues includes bunny script id when provided", async () => {
    const parsed = await formBlob({
      hostingId: "98765",
      name: "Test Site",
      siteUrl: "test.b-cdn.net",
    });
    expect(parsed.s).toBe("98765");
  });

  test("toDbValues omits bunny script id when empty", async () => {
    const parsed = await formBlob({
      name: "Test Site",
      siteUrl: "test.b-cdn.net",
    });
    expect(parsed.s).toBeUndefined();
  });

  test("parseSiteDataBlob decodes stored site-data JSON", async () => {
    const parsed = await formBlob({
      name: "My Site",
      siteUrl: "my.b-cdn.net",
    });
    expect(parsed.n).toBe("My Site");
    expect(parsed.u).toBe("my.b-cdn.net");
    expect(parsed.v).toBe(1);
  });

  test("parseSiteDataBlob handles legacy blobs without db keys", () => {
    const legacyBlob = JSON.stringify({
      n: "Old Site",
      u: "old.b-cdn.net",
      v: 1,
    });
    const parsed = parseSiteDataBlob(legacyBlob);
    expect(parsed.d).toBeUndefined();
    expect(parsed.t).toBeUndefined();
    expect(parsed.s).toBeUndefined();
  });

  test("insertBuiltSite creates a row with encrypted site_data", async () => {
    const row = await insertBuiltSite("Alpha Site", "alpha.b-cdn.net");
    expect(row.id).toBe(1);
    expect(row.created).toBeTruthy();
  });

  test("insertBuiltSite stores db credentials when provided", async () => {
    await insertBuiltSite(
      "DB Site",
      "db.b-cdn.net",
      "libsql://db.turso.io",
      "secret-token",
    );
    const sites = await getAllBuiltSites();
    const site = sites.find((s) => s.name === "DB Site")!;
    expect(site.dbUrl).toBe("libsql://db.turso.io");
    expect(site.dbToken).toBe("secret-token");
  });

  test("insertBuiltSite defaults db credentials to empty strings", async () => {
    await insertBuiltSite("No DB Site", "nodb.b-cdn.net");
    const sites = await getAllBuiltSites();
    const site = sites.find((s) => s.name === "No DB Site")!;
    expect(site.dbUrl).toBe("");
    expect(site.dbToken).toBe("");
  });

  test("insertBuiltSite stores bunny script id when provided", async () => {
    await insertBuiltSite(
      "Script Site",
      "script.b-cdn.net",
      "",
      "",
      false,
      "12345",
    );
    const sites = await getAllBuiltSites();
    const site = sites.find((s) => s.name === "Script Site")!;
    expect(site.hostingId).toBe("12345");
  });

  test("insertBuiltSite defaults bunny script id to empty string", async () => {
    await insertBuiltSite("No Script Site", "noscript.b-cdn.net");
    const sites = await getAllBuiltSites();
    const site = sites.find((s) => s.name === "No Script Site")!;
    expect(site.hostingId).toBe("");
  });

  test("getAllBuiltSites returns decrypted sites sorted by name", async () => {
    await insertBuiltSite("Charlie", "charlie.b-cdn.net");
    await insertBuiltSite("Alpha", "alpha.b-cdn.net");
    await insertBuiltSite("Bravo", "bravo.b-cdn.net");

    const sites = await getAllBuiltSites();
    expect(sites).toHaveLength(3);
    expect(sites[0]!.name).toBe("Alpha");
    expect(sites[0]!.siteUrl).toBe("alpha.b-cdn.net");
    expect(sites[1]!.name).toBe("Bravo");
    expect(sites[2]!.name).toBe("Charlie");
  });

  test("getAllBuiltSites returns empty array when no sites exist", async () => {
    const sites = await getAllBuiltSites();
    expect(sites).toHaveLength(0);
  });

  describe("builtSitesCrudTable", () => {
    const insertOriginalSite = () =>
      builtSitesCrudTable.insert({
        assignable: false,
        dbToken: "",
        dbUrl: "",
        hostingId: "",
        name: "Original",
        siteUrl: "original.bunny.run",
      });

    test("findAll returns all built sites", async () => {
      await insertBuiltSite("Site A", "a.bunny.run");
      await insertBuiltSite("Site B", "b.bunny.run");

      const sites = await builtSitesCrudTable.findAll();
      expect(sites).toHaveLength(2);
    });

    test("fromDb returns the row unchanged", async () => {
      const site = {
        assignable: false,
        assignedAttendeeId: null,
        assignedListingId: null,
        created: "2026-01-01",
        dbProvider: "bunny" as const,
        dbToken: "",
        dbUrl: "",
        hostingId: "",
        hostingProvider: "bunny" as const,
        id: 1,
        name: "Test",
        readOnlyFrom: "",
        renewalToken: null,
        renewalTokenIndex: null,
        siteUrl: "test.bunny.run",
        updates: "release" as const,
      };
      const result = await builtSitesCrudTable.fromDb(site);
      expect(result).toEqual(site);
    });

    test("inputKeyMap exposes form-facing fields", () => {
      expect(builtSitesCrudTable.inputKeyMap).toEqual({
        assignable: "assignable",
        db_provider: "dbProvider",
        db_token: "dbToken",
        db_url: "dbUrl",
        hosting_id: "hostingId",
        hosting_provider: "hostingProvider",
        name: "name",
        site_url: "siteUrl",
        updates: "updates",
      });
    });

    test("rowToInput exposes form-input fields for reuse", () => {
      const site = {
        assignable: true,
        assignedAttendeeId: null,
        assignedListingId: null,
        created: "2026-01-01",
        dbProvider: "bunny" as const,
        dbToken: "token",
        dbUrl: "libsql://db",
        hostingId: "script-123",
        hostingProvider: "bunny" as const,
        id: 42,
        name: "Mirror",
        readOnlyFrom: "",
        renewalToken: null,
        renewalTokenIndex: null,
        siteUrl: "example.bunny.run",
        updates: "beta" as const,
      };
      expect(builtSitesCrudTable.rowToInput(site)).toEqual({
        assignable: true,
        dbProvider: "bunny",
        dbToken: "token",
        dbUrl: "libsql://db",
        hostingId: "script-123",
        hostingProvider: "bunny",
        name: "Mirror",
        siteUrl: "example.bunny.run",
        updates: "beta",
      });
    });

    test("toDbValues builds encrypted blob from input", async () => {
      const values = await builtSitesCrudTable.toDbValues({
        assignable: false,
        dbToken: "tok123",
        dbUrl: "libsql://test.turso.io",
        hostingId: "777",
        name: "Test",
        siteUrl: "test.bunny.run",
      });
      expect(values.site_data).toBeTruthy();
      const parsed = parseSiteDataBlob(values.site_data as string);
      expect(parsed.n).toBe("Test");
      expect(parsed.u).toBe("test.bunny.run");
      expect(parsed.d).toBe("libsql://test.turso.io");
      expect(parsed.t).toBe("tok123");
      expect(parsed.s).toBe("777");
    });

    test("update preserves existing name when only siteUrl provided", async () => {
      const site = await insertOriginalSite();
      const updated = await builtSitesCrudTable.update(site.id, {
        siteUrl: "new.bunny.run",
      });
      expect(updated!.name).toBe("Original");
      expect(updated!.siteUrl).toBe("new.bunny.run");
    });

    test("update preserves existing siteUrl when only name provided", async () => {
      const site = await insertOriginalSite();
      const updated = await builtSitesCrudTable.update(site.id, {
        name: "Updated",
      });
      expect(updated!.name).toBe("Updated");
      expect(updated!.siteUrl).toBe("original.bunny.run");
    });

    test("update preserves existing db credentials when not provided", async () => {
      const site = await builtSitesCrudTable.insert({
        assignable: false,
        dbToken: "tok123",
        dbUrl: "libsql://db.turso.io",
        hostingId: "",
        name: "Original",
        siteUrl: "original.bunny.run",
      });
      const updated = await builtSitesCrudTable.update(site.id, {
        name: "Updated",
      });
      expect(updated!.dbUrl).toBe("libsql://db.turso.io");
      expect(updated!.dbToken).toBe("tok123");
    });

    test("update preserves existing bunny script id when not provided", async () => {
      const site = await builtSitesCrudTable.insert({
        assignable: false,
        dbToken: "",
        dbUrl: "",
        hostingId: "98765",
        name: "Original",
        siteUrl: "original.bunny.run",
      });
      const updated = await builtSitesCrudTable.update(site.id, {
        name: "Updated",
      });
      expect(updated!.hostingId).toBe("98765");
    });

    test("update changes bunny script id when provided", async () => {
      const site = await builtSitesCrudTable.insert({
        assignable: false,
        dbToken: "",
        dbUrl: "",
        hostingId: "111",
        name: "Original",
        siteUrl: "original.bunny.run",
      });
      const updated = await builtSitesCrudTable.update(site.id, {
        hostingId: "222",
      });
      expect(updated!.hostingId).toBe("222");
    });

    test("update returns null for non-existent id", async () => {
      const result = await builtSitesCrudTable.update(999, {
        name: "Test",
      });
      expect(result).toBeNull();
    });

    test("toDbValues handles partial input with missing fields", async () => {
      const values = await builtSitesCrudTable.toDbValues({});
      const parsed = parseSiteDataBlob(values.site_data as string);
      expect(parsed.n).toBe("");
      expect(parsed.u).toBe("");
    });

    test("toDbValues sets assignable to 1 when true", async () => {
      const values = await builtSitesCrudTable.toDbValues({
        assignable: true,
        dbToken: "",
        dbUrl: "",
        hostingId: "",
        name: "Test",
        siteUrl: "test.bunny.run",
      });
      expect(values.assignable).toBe(1);
    });
  });

  describe("assignable sites", () => {
    test("insertBuiltSite with assignable flag", async () => {
      await insertBuiltSite("Assignable Site", "a.b-cdn.net", "", "", true);
      const sites = await getAllBuiltSites();
      const site = sites.find((s) => s.name === "Assignable Site")!;
      expect(site.assignable).toBe(true);
    });

    test("insertBuiltSite defaults to not assignable", async () => {
      await insertBuiltSite("Default Site", "d.b-cdn.net");
      const sites = await getAllBuiltSites();
      const site = sites.find((s) => s.name === "Default Site")!;
      expect(site.assignable).toBe(false);
    });

    test("getAssignableBuiltSites filters to assignable only", async () => {
      await insertBuiltSite("Site A", "a.b-cdn.net", "", "", true);
      await insertBuiltSite("Site B", "b.b-cdn.net", "", "", false);
      await insertBuiltSite("Site C", "c.b-cdn.net", "", "", true);
      const sites = await getAssignableBuiltSites();
      expect(sites).toHaveLength(2);
      expect(sites.every((s) => s.assignable)).toBe(true);
    });

    test("assignBuiltSite marks site as not assignable and stores IDs in columns", async () => {
      await insertBuiltSite("To Assign", "assign.b-cdn.net", "", "", true);
      const sites = await getAllBuiltSites();
      const site = sites.find((s) => s.name === "To Assign")!;

      const updated = await assignBuiltSite(site.id, 42, 7);
      expect(updated).not.toBeNull();
      expect(updated!.assignable).toBe(false);
      expect(updated!.assignedAttendeeId).toBe(42);
      expect(updated!.assignedListingId).toBe(7);
    });

    test("assignBuiltSite returns null for non-existent site", async () => {
      const result = await assignBuiltSite(999, 1, 1);
      expect(result).toBeNull();
    });

    test("unassigned sites have null attendee and listing IDs", async () => {
      await insertBuiltSite("Unassigned", "u.b-cdn.net", "", "", true);
      const sites = await getAllBuiltSites();
      const site = sites.find((s) => s.name === "Unassigned")!;
      expect(site.assignedAttendeeId).toBeNull();
      expect(site.assignedListingId).toBeNull();
    });
  });

  describe("renewal columns", () => {
    test("new sites have empty readOnlyFrom and null renewal fields", async () => {
      await insertBuiltSite("Renewal Site", "renewal.b-cdn.net");
      const sites = await getAllBuiltSites();
      const site = sites.find((s) => s.name === "Renewal Site")!;
      expect(site.readOnlyFrom).toBe("");
      expect(site.renewalTokenIndex).toBeNull();
    });

    test("getBuiltSiteByRenewalTokenIndex returns matching site", async () => {
      await insertBuiltSite("Token Site", "token.b-cdn.net");
      const sites = await getAllBuiltSites();
      const site = sites.find((s) => s.name === "Token Site")!;

      await updateBuiltSiteRenewalState(site.id, {
        readOnlyFrom: "2026-07-01T00:00:00Z",
        renewalToken: "raw-token-123",
        renewalTokenIndex: "test-index-abc",
      });

      const found = await getBuiltSiteByRenewalTokenIndex("test-index-abc");
      expect(found).not.toBeNull();
      expect(found!.name).toBe("Token Site");
      expect(found!.readOnlyFrom).toBe("2026-07-01T00:00:00Z");
    });

    test("getBuiltSiteByRenewalTokenIndex returns null when no match", async () => {
      const found = await getBuiltSiteByRenewalTokenIndex("nonexistent");
      expect(found).toBeNull();
    });

    test("multiple sites with null renewalTokenIndex are allowed", async () => {
      await insertBuiltSite("Site 1", "s1.b-cdn.net");
      await insertBuiltSite("Site 2", "s2.b-cdn.net");
      const sites = await getAllBuiltSites();
      const nullIndexSiteNames = sites
        .filter((s) => s.renewalTokenIndex === null)
        .map((s) => s.name)
        .sort();
      expect(nullIndexSiteNames).toEqual(["Site 1", "Site 2"]);
    });

    test("legacy blob still decodes correctly (no rt field)", () => {
      const legacyBlob = JSON.stringify({
        n: "Old Site",
        u: "old.b-cdn.net",
        v: 1,
      });
      const parsed = parseSiteDataBlob(legacyBlob);
      expect(parsed.rt).toBeUndefined();
      expect(parsed.n).toBe("Old Site");
    });

    test("CRUD update preserves existing renewal token", async () => {
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

      const updated = await builtSitesCrudTable.update(site.id, {
        name: "Token Preserve Updated",
      });

      expect(updated!.name).toBe("Token Preserve Updated");
      expect(updated!.renewalTokenIndex).toBe("idx-123");
      expect(updated!.readOnlyFrom).toBe("2026-08-01T00:00:00Z");
      expect(updated!.renewalToken).toBe("secret-token");
    });

    test("updateBuiltSiteRenewalState updates individual fields", async () => {
      await insertBuiltSite("Renewal Update", "ru.b-cdn.net");
      const sites = await getAllBuiltSites();
      const site = sites.find((s) => s.name === "Renewal Update")!;

      await updateBuiltSiteRenewalState(site.id, {
        readOnlyFrom: "2027-01-01T00:00:00Z",
      });
      const afterFirst = await getAllBuiltSites();
      const updatedAfterFirst = afterFirst.find((s) => s.id === site.id)!;
      expect(updatedAfterFirst.readOnlyFrom).toBe("2027-01-01T00:00:00Z");
      expect(updatedAfterFirst.renewalTokenIndex).toBeNull();

      await updateBuiltSiteRenewalState(site.id, {
        renewalToken: "tok-456",
        renewalTokenIndex: "idx-456",
      });
      const afterSecond = await getBuiltSiteByRenewalTokenIndex("idx-456");
      expect(afterSecond).not.toBeNull();
      expect(afterSecond!.renewalTokenIndex).toBe("idx-456");
      expect(afterSecond!.renewalToken).toBe("tok-456");
      expect(afterSecond!.readOnlyFrom).toBe("2027-01-01T00:00:00Z");
    });
  });

  describe("update channel", () => {
    const crudInput = (
      overrides: Partial<Parameters<typeof builtSitesCrudTable.insert>[0]> = {},
    ): Parameters<typeof builtSitesCrudTable.insert>[0] => ({
      assignable: false,
      dbToken: "",
      dbUrl: "",
      hostingId: "",
      name: "Channel Site",
      siteUrl: "chan.b-cdn.net",
      ...overrides,
    });

    test("insertBuiltSite defaults the channel to release", async () => {
      await insertBuiltSite("Defaulted", "defaulted.b-cdn.net");
      const site = (await getAllBuiltSites()).find(
        (s) => s.name === "Defaulted",
      )!;
      expect(site.updates).toBe("release");
    });

    test("insertBuiltSite stores an explicit channel that round-trips", async () => {
      await insertBuiltSite(
        "Alpha Chan",
        "ac.b-cdn.net",
        "",
        "",
        false,
        "",
        "alpha",
      );
      const site = (await getAllBuiltSites()).find(
        (s) => s.name === "Alpha Chan",
      )!;
      expect(site.updates).toBe("alpha");
    });

    test("CRUD insert defaults the channel to release when omitted", async () => {
      const site = await builtSitesCrudTable.insert(
        crudInput({ name: "Crud Default" }),
      );
      expect(site.updates).toBe("release");
    });

    test("CRUD insert persists an explicit channel through the DB", async () => {
      const site = await builtSitesCrudTable.insert(
        crudInput({ name: "Crud Beta", updates: "beta" }),
      );
      expect(site.updates).toBe("beta");
      const reloaded = (await getAllBuiltSites()).find(
        (s) => s.id === site.id,
      )!;
      expect(reloaded.updates).toBe("beta");
    });

    test("CRUD update changes the channel", async () => {
      const site = await builtSitesCrudTable.insert(
        crudInput({ name: "Chan Change" }),
      );
      const updated = await builtSitesCrudTable.update(site.id, {
        updates: "alpha",
      });
      expect(updated!.updates).toBe("alpha");
    });

    test("CRUD update preserves the channel when other fields change", async () => {
      const site = await builtSitesCrudTable.insert(
        crudInput({ name: "Keep Chan", updates: "beta" }),
      );
      const updated = await builtSitesCrudTable.update(site.id, {
        name: "Keep Chan Renamed",
      });
      expect(updated!.name).toBe("Keep Chan Renamed");
      expect(updated!.updates).toBe("beta");
    });

    test("assigning a site preserves its update channel", async () => {
      await insertBuiltSite(
        "Assign Chan",
        "ach.b-cdn.net",
        "",
        "",
        true,
        "",
        "beta",
      );
      const site = (await getAllBuiltSites()).find(
        (s) => s.name === "Assign Chan",
      )!;
      const updated = await assignBuiltSite(site.id, 1, 2);
      expect(updated!.updates).toBe("beta");
    });

    test("updating renewal state preserves the update channel", async () => {
      await insertBuiltSite(
        "Renew Chan",
        "rch.b-cdn.net",
        "",
        "",
        false,
        "",
        "alpha",
      );
      const site = (await getAllBuiltSites()).find(
        (s) => s.name === "Renew Chan",
      )!;
      await updateBuiltSiteRenewalState(site.id, {
        readOnlyFrom: "2027-01-01T00:00:00Z",
      });
      const reloaded = (await getAllBuiltSites()).find(
        (s) => s.id === site.id,
      )!;
      expect(reloaded.updates).toBe("alpha");
    });
  });
});
