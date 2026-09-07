import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { buildTicketListing } from "#booking/model.ts";

import {
  concealLineNames,
  ctxStandInNames,
  hasNamedBookingPath,
  packageStandIns,
  standInNameFor,
} from "#shared/package-privacy.ts";

import { testListingWithCount } from "#test-utils/factories.ts";
import { treePackage } from "#test-utils/package-cap-fixtures.ts";

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
    const result = concealLineNames(items, standIns, new Set());
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
    // Neither line uses the hidden package path.
    expect(
      concealLineNames(items, standIns, new Set([1])).map((i) => i.name),
    ).toEqual(["Secret A", "Secret A"]);
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
    expect(
      concealLineNames(items, standIns, new Set()).map((i) => i.name),
    ).toEqual(["Secret Box", "Mystery Kit"]);
  });

  test("concealLineNames is a no-op when nothing is concealed", () => {
    const items = [{ listingId: 3, name: "Open Thing" }];
    expect(
      concealLineNames(
        items,
        { byGroupId: new Map(), byListingId: new Map() },
        new Set(),
      ),
    ).toBe(items);
  });

  test("a named child does not reveal a tagged package line", () => {
    const standIns = packageStandIns(packages, childIds);
    const items = [
      { listingId: 2, name: "Secret B", packageGroupId: 7 },
      { listingId: 9, name: "Child" },
    ];
    expect(
      concealLineNames(items, standIns, new Set([2, 9])).map(
        (item) => item.name,
      ),
    ).toEqual(["Secret Box", "Child"]);
    expect(
      concealLineNames(items, standIns, new Set()).map((item) => item.name),
    ).toEqual(["Secret Box", "Secret Box"]);
  });

  test("a child error names its actual concealed parent package", () => {
    const standIns = packageStandIns(
      [
        ...packages,
        {
          groupId: 10,
          hideListings: true,
          memberListingIds: [4],
          name: "Second Box",
        },
      ],
      () => [9],
    );
    const nameFor = standInNameFor(standIns, new Set([3]));
    expect(nameFor(9, [2])).toBe("Secret Box");
    expect(nameFor(9, [4])).toBe("Second Box");
    expect(nameFor(9, [3])).toBeUndefined();
    expect(nameFor(9, [4, 3])).toBeUndefined();
    expect(nameFor(9, [4, 2])).toBe("Second Box");
    expect(nameFor(3, [2])).toBeUndefined();
    expect(nameFor(9)).toBe("Second Box");
    expect(nameFor(99)).toBeUndefined();
  });

  test("an empty-named hidden package still conceals its children", () => {
    // The parent's empty stand-in wins; the child's own missing entry must
    // not turn the empty name into "not concealed".
    const standIns = packageStandIns(
      [{ groupId: 7, hideListings: true, memberListingIds: [2], name: "" }],
      () => [],
    );
    const nameFor = standInNameFor(standIns, new Set());
    expect(nameFor(9, [2])).toBe("");
  });
});

describe("hasNamedBookingPath", () => {
  const DISPLAYS = new Map([
    [1, { hideListings: false, name: "Open Kit" }],
    [2, { hideListings: true, name: "Box Kit" }],
  ]);

  for (const [ids, expected] of [
    [[], false],
    [[0], true],
    [[1], true],
    [[2], false],
    [[99], false],
    [[2, 0], true],
    [[2, 1], true],
    [[2, 99], false],
  ] as const) {
    test(`identifies a named path in ${JSON.stringify(ids)}`, () => {
      expect(hasNamedBookingPath(DISPLAYS, ids)).toBe(expected);
    });
  }
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
