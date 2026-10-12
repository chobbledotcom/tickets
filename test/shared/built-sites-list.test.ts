import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  inBuiltSitesOrder,
  readBuiltSitesSort,
} from "#shared/built-sites-list.ts";
import { testBuiltSite } from "#test-utils/factories.ts";

const site = (
  overrides: Parameters<typeof testBuiltSite>[0],
): ReturnType<typeof testBuiltSite> => testBuiltSite(overrides);

describe("readBuiltSitesSort", () => {
  test("falls back to name when the address names no sort", () => {
    expect(readBuiltSitesSort(new URLSearchParams(""))).toBe("name");
  });

  test("falls back to name for an unknown sort value", () => {
    expect(readBuiltSitesSort(new URLSearchParams("sort=newest"))).toBe("name");
  });

  test("reads each sort the list offers", () => {
    for (const sortOrder of ["name", "created", "read_only_from"] as const) {
      expect(readBuiltSitesSort(new URLSearchParams(`sort=${sortOrder}`))).toBe(
        sortOrder,
      );
    }
  });
});

describe("inBuiltSitesOrder", () => {
  const alpha = site({ created: "2026-01-01T00:00:00Z", id: 1, name: "Alpha" });
  const beta = site({ created: "2026-03-01T00:00:00Z", id: 2, name: "Beta" });
  const gamma = site({ created: "2026-02-01T00:00:00Z", id: 3, name: "Gamma" });

  test("sorts by name from A to Z", () => {
    expect(
      inBuiltSitesOrder("name")([gamma, alpha, beta]).map((s) => s.name),
    ).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  test("sorts by created date, newest first", () => {
    expect(
      inBuiltSitesOrder("created")([alpha, beta, gamma]).map((s) => s.name),
    ).toEqual(["Beta", "Gamma", "Alpha"]);
  });

  test("sorts by read-only deadline, soonest first, no deadline last", () => {
    const dated = site({
      id: 4,
      name: "Dated",
      readOnlyFrom: "2026-06-01T00:00:00Z",
    });
    const sooner = site({
      id: 5,
      name: "Sooner",
      readOnlyFrom: "2026-05-01T00:00:00Z",
    });
    const undated = site({ id: 6, name: "Undated", readOnlyFrom: "" });
    expect(
      inBuiltSitesOrder("read_only_from")([undated, dated, sooner]).map(
        (s) => s.name,
      ),
    ).toEqual(["Sooner", "Dated", "Undated"]);
  });

  test("compares deadline instants, not their spelling", () => {
    const zuluSpelling = site({
      id: 10,
      name: "Alpha",
      readOnlyFrom: "2026-10-31T23:59:59Z",
    });
    const millisSpelling = site({
      id: 11,
      name: "Zulu",
      readOnlyFrom: "2026-10-31T23:59:59.000Z",
    });
    const undated = site({ id: 12, name: "Undated", readOnlyFrom: "" });
    expect(
      inBuiltSitesOrder("read_only_from")([
        undated,
        millisSpelling,
        zuluSpelling,
      ]).map((s) => s.name),
    ).toEqual(["Alpha", "Zulu", "Undated"]);
    const exactSecond = site({
      id: 13,
      name: "Zeta",
      readOnlyFrom: "2026-10-31T23:59:59Z",
    });
    const halfSecondLater = site({
      id: 14,
      name: "Alpha",
      readOnlyFrom: "2026-10-31T23:59:59.500Z",
    });
    expect(
      inBuiltSitesOrder("read_only_from")([halfSecondLater, exactSecond]).map(
        (s) => s.name,
      ),
    ).toEqual(["Zeta", "Alpha"]);
  });

  test("breaks equal sort keys by name", () => {
    const first = site({
      created: "2026-01-01T00:00:00Z",
      id: 7,
      name: "Zeta",
    });
    expect(
      inBuiltSitesOrder("created")([first, alpha]).map((s) => s.name),
    ).toEqual(["Alpha", "Zeta"]);
    const lateZ = site({
      id: 8,
      name: "Zulu",
      readOnlyFrom: "2026-06-01T00:00:00Z",
    });
    const lateA = site({
      id: 9,
      name: "Alp",
      readOnlyFrom: "2026-06-01T00:00:00Z",
    });
    expect(
      inBuiltSitesOrder("read_only_from")([lateZ, lateA]).map((s) => s.name),
    ).toEqual(["Alp", "Zulu"]);
    const noneZ = site({ id: 15, name: "Zed", readOnlyFrom: "" });
    const noneA = site({ id: 16, name: "Amy", readOnlyFrom: "" });
    expect(
      inBuiltSitesOrder("read_only_from")([noneZ, noneA]).map((s) => s.name),
    ).toEqual(["Amy", "Zed"]);
  });
});
