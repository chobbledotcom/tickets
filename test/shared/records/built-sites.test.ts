import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { BuiltSiteFormInput } from "#db/built-sites/types.ts";
import { builtSites } from "#db/built-sites.ts";
import { builtSiteRecord } from "#shared/records/built-sites.ts";
import { activityMessages } from "#test-utils/activity-log.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { deleteConfirmLabel } from "#test-utils/record-labels.ts";

const siteInput = (name: string): BuiltSiteFormInput => ({
  assignable: false,
  dbProvider: "bunny",
  dbToken: "",
  dbUrl: "",
  hostingId: "",
  hostingProvider: "bunny",
  name,
  siteUrl: "https://shop.b-cdn.net",
});

const writtenName = (verdict: { kind: string; row?: { name: string } }) =>
  verdict.kind === "written" ? verdict.row?.name : verdict.kind;

describe("the built site record's declaration", () => {
  test("names a built site on its pages and its delete page", () => {
    expect(builtSiteRecord.activityName).toBe("Built site");
    expect(deleteConfirmLabel(builtSiteRecord)).toBe("Built site name");
  });
});

describeWithEnv("the built site record's commands", { db: true }, () => {
  test("creates a built site and logs it with the site name", async () => {
    expect(writtenName(await builtSiteRecord.create(siteInput("Shop")))).toBe(
      "Shop",
    );
    expect((await builtSites.getAll()).map((site) => site.name)).toEqual([
      "Shop",
    ]);
    expect(await activityMessages()).toEqual(["Built site 'Shop' created"]);
  });

  test("updates the one site it names and logs it", async () => {
    await builtSiteRecord.create(siteInput("First"));
    const second = await builtSiteRecord.create(siteInput("Second"));
    if (second.kind !== "written") throw new Error("create failed");

    expect(
      writtenName(
        await builtSiteRecord.update(second.row.id, siteInput("Renamed")),
      ),
    ).toBe("Renamed");
    expect((await builtSites.getAll()).map((site) => site.name).sort()).toEqual(
      ["First", "Renamed"],
    );
    expect((await activityMessages())[0]).toBe("Built site 'Renamed' updated");
  });

  test("answers not-found for an update of a missing site", async () => {
    expect(await builtSiteRecord.update(99, siteInput("Gone"))).toEqual({
      kind: "not-found",
    });
  });

  test("deletes a built site and logs it with the site name", async () => {
    const created = await builtSiteRecord.create(siteInput("Old"));
    if (created.kind !== "written") throw new Error("create failed");

    expect(await builtSiteRecord.remove(created.row.id)).toEqual({
      kind: "deleted",
    });
    expect(await builtSites.getAll()).toEqual([]);
    expect((await activityMessages())[0]).toBe("Built site 'Old' deleted");
  });
});
