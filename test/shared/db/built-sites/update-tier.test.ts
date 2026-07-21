import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  assignBuiltSite,
  builtSites,
  builtSitesCrudTable,
  insertBuiltSite,
  updateBuiltSiteRenewalState,
} from "#shared/db/built-sites.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { builtSiteFormInput } from "./fixtures.ts";

describeWithEnv("built-site update channel", { db: true }, () => {
  test("insertBuiltSite defaults the channel to release", async () => {
    await insertBuiltSite("Defaulted", "defaulted.b-cdn.net");
    expect((await builtSites.getAll())[0]?.updates).toBe("release");
  });

  test("insertBuiltSite stores an explicit channel", async () => {
    await insertBuiltSite(
      "Alpha Chan",
      "ac.b-cdn.net",
      "",
      "",
      false,
      "",
      "alpha",
    );
    expect((await builtSites.getAll())[0]?.updates).toBe("alpha");
  });

  test("CRUD insert defaults the channel to release", async () => {
    expect(
      await builtSitesCrudTable.insert(
        builtSiteFormInput({ name: "Crud Default" }),
      ),
    ).toMatchObject({ updates: "release" });
  });

  test("CRUD insert persists an explicit channel", async () => {
    const site = await builtSitesCrudTable.insert(
      builtSiteFormInput({ name: "Crud Beta", updates: "beta" }),
    );
    expect(site.updates).toBe("beta");
    expect((await builtSites.getAll())[0]?.updates).toBe("beta");
  });

  test("CRUD update changes the channel", async () => {
    const site = await builtSitesCrudTable.insert(builtSiteFormInput());
    expect(
      await builtSitesCrudTable.update(site.id, { updates: "alpha" }),
    ).toMatchObject({ updates: "alpha" });
  });

  test("CRUD update preserves the channel", async () => {
    const site = await builtSitesCrudTable.insert(
      builtSiteFormInput({ updates: "beta" }),
    );
    expect(
      await builtSitesCrudTable.update(site.id, { name: "Renamed" }),
    ).toMatchObject({ name: "Renamed", updates: "beta" });
  });

  test("assigning a site preserves its channel", async () => {
    const row = await insertBuiltSite(
      "Assign Chan",
      "ach.b-cdn.net",
      "",
      "",
      true,
      "",
      "beta",
    );
    expect(await assignBuiltSite(row.id, 1, 2)).toMatchObject({
      updates: "beta",
    });
  });

  test("updating renewal state preserves the channel", async () => {
    const row = await insertBuiltSite(
      "Renew Chan",
      "rch.b-cdn.net",
      "",
      "",
      false,
      "",
      "alpha",
    );
    await updateBuiltSiteRenewalState(row.id, {
      readOnlyFrom: "2027-01-01T00:00:00Z",
    });
    expect((await builtSites.getAll())[0]?.updates).toBe("alpha");
  });
});
