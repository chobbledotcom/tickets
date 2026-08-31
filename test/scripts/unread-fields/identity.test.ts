import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  compareFindingIdentities,
  type FindingIdentity,
  findingIdentityKey,
  findingIdentityText,
  findingPath,
  identitiesAt,
  ownerPath,
} from "#scripts/unread-fields/identity.ts";

const identity = (
  path: FindingIdentity["path"],
  field = "total",
  exportedFrom = "src/sum.ts",
): FindingIdentity => ({ exportedFrom, field, path });

describe("unread-field identities", () => {
  test("keeps a named field separate from an unnamed route with the same text", () => {
    const named = identity([{ name: "Rows" }, { name: "[]" }]);
    const reached = identity([{ name: "Rows" }, { way: "[]" }]);

    expect(findingIdentityKey(named)).not.toBe(findingIdentityKey(reached));
    expect(findingIdentityText(named)).not.toBe(findingIdentityText(reached));
  });

  test("keeps one dotted name separate from two names", () => {
    const oneName = identity([{ name: "a.b" }]);
    const twoNames = identity([{ name: "a" }, { name: "b" }]);

    expect(findingIdentityKey(oneName)).not.toBe(findingIdentityKey(twoNames));
  });

  test("keeps matching owners from different exports separate", () => {
    const first = identity([{ name: "Sum" }]);
    const second = identity([{ name: "Sum" }], "total", "src/other.ts");

    expect(findingIdentityKey(first)).not.toBe(findingIdentityKey(second));
  });

  test("renders the path the way a reader reaches it", () => {
    expect(
      findingPath(
        identity([{ name: "Rows" }, { way: "[]" }, { name: "has.a.dot" }]),
      ),
    ).toBe('Rows["[]"]["has.a.dot"].total');
  });

  test("builds one exact identity for each supplied field", () => {
    expect(
      identitiesAt("src/sum.ts", [{ name: "Sum" }])(["total", "other"]),
    ).toEqual([
      identity([{ name: "Sum" }]),
      identity([{ name: "Sum" }], "other"),
    ]);
  });

  test("sorts by export and exact structured path", () => {
    const identities = [
      identity([{ name: "Sum" }, { way: "[]" }]),
      identity([{ name: "Sum" }, { name: "[]" }]),
      identity([{ name: "Sum" }], "b"),
      identity([{ name: "Sum" }], "a", "src/a.ts"),
    ].toSorted(compareFindingIdentities);

    expect(identities.map(findingIdentityKey)).toEqual(
      [...identities].map(findingIdentityKey).toSorted(),
    );
    expect(compareFindingIdentities(identities.at(-1)!, identities[0]!)).toBe(
      1,
    );
  });

  test("calls two equal identities equal", () => {
    const same = identity([{ name: "Sum" }]);
    expect(compareFindingIdentities(same, { ...same })).toBe(0);
  });

  test("refuses a field path with no owner", () => {
    expect(() => ownerPath([])).toThrow("An unread field has no owner");
  });

  test("shows each exact step in a diagnostic identity", () => {
    expect(
      findingIdentityText(identity([{ name: "Rows" }, { way: "[]" }], "total")),
    ).toBe('src/sum.ts :: name("Rows") / way("[]") / name("total")');
  });
});
