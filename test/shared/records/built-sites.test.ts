import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import type { BuiltSiteFormInput } from "#db/built-sites/types.ts";
import { builtSiteRecord } from "#shared/records/built-sites.ts";
import {
  expectCreateThenDelete,
  expectWrittenAndLogged,
  listedNames,
  testMissingUpdate,
  writtenRow,
} from "#test-utils/record-commands.ts";
import { describeRecord } from "#test-utils/record-labels.ts";

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

const createSite = async (name: string) =>
  (await writtenRow(builtSiteRecord.create(siteInput(name)))).id;

describeRecord(builtSiteRecord, "Built site", "Built site name", () => {
  test("creates a built site and logs it with the site name", async () => {
    await expectWrittenAndLogged(
      builtSiteRecord.create(siteInput("Shop")),
      { name: "Shop" },
      ["Built site 'Shop' created"],
    );
    expect(await listedNames(builtSiteRecord)).toEqual(["Shop"]);
  });

  test("updates the one site it names and logs it", async () => {
    await createSite("First");
    const second = await createSite("Second");

    await expectWrittenAndLogged(
      builtSiteRecord.update(second, siteInput("Renamed")),
      { id: second, name: "Renamed" },
      [
        "Built site 'Renamed' updated",
        "Built site 'Second' created",
        "Built site 'First' created",
      ],
    );
    expect((await listedNames(builtSiteRecord)).toSorted()).toEqual([
      "First",
      "Renamed",
    ]);
  });

  testMissingUpdate(builtSiteRecord, siteInput("Gone"));

  test("deletes a built site and logs it with the site name", async () => {
    await expectCreateThenDelete(builtSiteRecord, siteInput("Old"), [
      "Built site 'Old' deleted",
      "Built site 'Old' created",
    ]);
    expect(await listedNames(builtSiteRecord)).toEqual([]);
  });
});
