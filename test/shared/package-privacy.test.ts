import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { buildTicketListing } from "#booking/model.ts";
import { groups } from "#db/groups.ts";
import {
  concealLineNames,
  concealMemberNames,
  ctxStandInNames,
  memberStandInName,
  namesConcealed,
  packagePrivacy,
  packagePrivacyOfDisplay,
  packageStandIns,
  resolveNamesConcealed,
} from "#shared/package-privacy.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { testListingWithCount } from "#test-utils/factories.ts";
import { treePackage } from "#test-utils/package-cap-fixtures.ts";

const HIDDEN = packagePrivacy(true, "Welcome Pack");
const SHOWN = packagePrivacy(false, "Welcome Pack");

describe("package privacy (pure)", () => {
  test("a hidden package conceals member names behind the package name", () => {
    expect(namesConcealed(HIDDEN)).toBe(true);
    expect(memberStandInName(HIDDEN)).toBe("Welcome Pack");
  });

  test("a visible package (and a non-package) names members as usual", () => {
    expect(namesConcealed(SHOWN)).toBe(false);
    expect(memberStandInName(SHOWN)).toBeUndefined();
    expect(packagePrivacyOfDisplay(null)).toEqual({ kind: "visible" });
  });

  test("never reads a stale packageName off a visible privacy value", () => {
    // A visible PackagePrivacy has no packageName field, but nothing stops a
    // caller from holding a value that still carries one under the hood (e.g.
    // built by spreading a once-hidden value and overwriting `kind`). The
    // "visible" branch must ignore it rather than leak it.
    const staleVisible = { ...HIDDEN, kind: "visible" as const };
    expect(memberStandInName(staleVisible)).toBeUndefined();
  });

  test("a display resolves through the same constructor", () => {
    expect(
      packagePrivacyOfDisplay({ hideListings: true, name: "Box" }),
    ).toEqual({ kind: "hidden", packageName: "Box" });
  });

  test("concealMemberNames renames every line, keeping ids and prices", () => {
    const items = [
      { listingId: 1, name: "Secret A", unitPrice: 500 },
      { listingId: 2, name: "Secret B", unitPrice: 700 },
    ];
    const result = concealMemberNames(items, HIDDEN);
    expect(result.map((i) => i.name)).toEqual(["Welcome Pack", "Welcome Pack"]);
    // Ids/prices are untouched so the webhook still revalidates each member.
    expect(result.map((i) => i.listingId)).toEqual([1, 2]);
    expect(result.map((i) => i.unitPrice)).toEqual([500, 700]);
  });

  test("concealMemberNames is a no-op for a visible order", () => {
    const items = [{ name: "Member" }];
    expect(concealMemberNames(items, SHOWN)).toBe(items);
  });
});

describe("per-path stand-in names (several bundles per page)", () => {
  const packages = [
    {
      groupId: 7,
      hideListings: true,
      memberListingIds: [1, 2],
      name: "Secret Box",
    },
    {
      groupId: 8,
      hideListings: false,
      memberListingIds: [3],
      name: "Open Kit",
    },
  ];
  const childIds = (memberId: number): number[] => (memberId === 2 ? [9] : []);

  test("covers a hidden package's members AND their required children", () => {
    const standIns = packageStandIns(packages, childIds);
    expect(standIns.byListingId.get(1)).toBe("Secret Box");
    expect(standIns.byListingId.get(2)).toBe("Secret Box");
    // Member 2's required child books as part of the hidden bundle.
    expect(standIns.byListingId.get(9)).toBe("Secret Box");
    expect(standIns.byGroupId.get(7)).toBe("Secret Box");
  });

  test("a visible package's members are never concealed", () => {
    const standIns = packageStandIns(packages, childIds);
    expect(standIns.byListingId.has(3)).toBe(false);
    expect(standIns.byListingId.size).toBe(3);
    expect(standIns.byGroupId.has(8)).toBe(false);
  });

  test("concealLineNames renames the hidden package's own tagged lines", () => {
    const standIns = packageStandIns(packages, childIds);
    const items = [
      { listingId: 1, name: "Secret A", packageGroupId: 7, unitPrice: 500 },
      { listingId: 3, name: "Open Thing", packageGroupId: 8, unitPrice: 700 },
    ];
    const result = concealLineNames(items, standIns);
    expect(result.map((i) => i.name)).toEqual(["Secret Box", "Open Thing"]);
    expect(result.map((i) => i.unitPrice)).toEqual([500, 700]);
  });

  test("a listing shared with a hidden package keeps its name on its OTHER paths", () => {
    // Listing 1 is a hidden package's member, but this order books it through
    // the VISIBLE package and its own standalone row — neither line belongs
    // to the hidden bundle, so renaming them would mislabel what each line
    // charges for (and the hidden bundle isn't even in this order).
    const standIns = packageStandIns(
      [packages[0]!, { ...packages[1]!, memberListingIds: [1] }],
      () => [],
    );
    const items = [
      { listingId: 1, name: "Secret A", packageGroupId: 8, unitPrice: 500 },
      { listingId: 1, name: "Secret A", unitPrice: 500 },
    ];
    // The untagged line is concealed by listing id (fail-safe: a folded child
    // of a hidden member rides an untagged line); the visible package's
    // tagged line keeps its real name.
    expect(concealLineNames(items, standIns).map((i) => i.name)).toEqual([
      "Secret A",
      "Secret Box",
    ]);
  });

  test("two hidden packages sharing a listing each name their OWN line", () => {
    const standIns = packageStandIns(
      [
        packages[0]!,
        {
          groupId: 8,
          hideListings: true,
          memberListingIds: [1],
          name: "Mystery Kit",
        },
      ],
      () => [],
    );
    const items = [
      { listingId: 1, name: "Secret A", packageGroupId: 7 },
      { listingId: 1, name: "Secret A", packageGroupId: 8 },
    ];
    expect(concealLineNames(items, standIns).map((i) => i.name)).toEqual([
      "Secret Box",
      "Mystery Kit",
    ]);
  });

  test("concealLineNames is a no-op when nothing is concealed", () => {
    const items = [{ listingId: 3, name: "Open Thing" }];
    expect(
      concealLineNames(items, { byGroupId: new Map(), byListingId: new Map() }),
    ).toBe(items);
  });
});

describeWithEnv("resolveNamesConcealed (fail-safe)", { db: true }, () => {
  test("an order booking no packages never conceals", async () => {
    expect(await resolveNamesConcealed([])).toBe(false);
  });

  test("a live package resolves its own hide flag", async () => {
    const shown = await createTestGroup({ isPackage: true, name: "Open Kit" });
    expect(await resolveNamesConcealed([shown.id])).toBe(false);

    const hidden = await createTestGroup({ isPackage: true, name: "Box Kit" });
    await groups.table.update(hidden.id, { hidePackageListings: true });
    expect(await resolveNamesConcealed([hidden.id])).toBe(true);
  });

  test("hidden when ANY of several booked packages hides its listings", async () => {
    const shown = await createTestGroup({ isPackage: true, name: "Kit A" });
    const hidden = await createTestGroup({ isPackage: true, name: "Kit B" });
    await groups.table.update(hidden.id, { hidePackageListings: true });
    expect(await resolveNamesConcealed([shown.id, hidden.id])).toBe(true);
  });

  test("a package id that no longer resolves fails SAFE as hidden", async () => {
    // The stale group may have been hidden; the refund path must not name its
    // members either way.
    const gone = await createTestGroup({ isPackage: true, name: "Gone Kit" });
    await groups.table.deleteById(gone.id);
    expect(await resolveNamesConcealed([gone.id])).toBe(true);
  });
});

describe("ctxStandInNames", () => {
  test("conceals a hidden package's members and their children", () => {
    const standIns = ctxStandInNames({
      childrenByParentId: new Map([
        [
          1,
          [
            buildTicketListing(
              testListingWithCount({ id: 9 }),
              false,
              undefined,
            ),
          ],
        ],
      ]),
      packages: [
        {
          ...treePackage(7, [1, 2]),
          hideListings: true,
          name: "Mystery Box",
        },
      ],
    });
    // Member 1's child 9 is concealed too; member 2 has no children entry.
    expect([...standIns.byListingId]).toEqual([
      [1, "Mystery Box"],
      [9, "Mystery Box"],
      [2, "Mystery Box"],
    ]);
    // The bundle's own tagged lines rename through its group id.
    expect([...standIns.byGroupId]).toEqual([[7, "Mystery Box"]]);
  });

  test("names nothing for a package that shows its listings", () => {
    const standIns = ctxStandInNames({
      childrenByParentId: new Map(),
      packages: [
        {
          ...treePackage(7, [1]),
          name: "Open Box",
        },
      ],
    });
    expect(standIns.byGroupId.size).toBe(0);
    expect(standIns.byListingId.size).toBe(0);
  });
});
