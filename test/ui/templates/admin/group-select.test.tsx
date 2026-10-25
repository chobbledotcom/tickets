import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { ListingGroupSelect } from "#templates/admin/group-select.tsx";
import { testGroup } from "#test-utils/factories.ts";

describe("ListingGroupSelect", () => {
  test("renders nothing when there are no groups", () => {
    expect(ListingGroupSelect({ groups: [], selectedGroupIds: [] })).toBe(null);
  });

  test("renders one unticked checkbox per group under the group legend", () => {
    const html = String(
      ListingGroupSelect({
        groups: [
          testGroup({ id: 3, name: "Weekend" }),
          testGroup({ id: 9, name: "Christmas Bundle" }),
        ],
        selectedGroupIds: [],
      }),
    );
    assertStringIncludes(html, '<fieldset class="checkboxes">');
    assertStringIncludes(html, "<legend>Group</legend>");
    assertStringIncludes(
      html,
      '<input name="group_ids" type="checkbox" value="3"> Weekend',
    );
    assertStringIncludes(
      html,
      '<input name="group_ids" type="checkbox" value="9"> Christmas Bundle',
    );
  });

  test("ticks only the group ids given as chosen", () => {
    const html = String(
      ListingGroupSelect({
        groups: [
          testGroup({ id: 3, name: "Weekend" }),
          testGroup({ id: 9, name: "Weekend" }),
        ],
        selectedGroupIds: [9],
      }),
    );
    assertStringIncludes(
      html,
      '<input name="group_ids" type="checkbox" value="3"> Weekend',
    );
    assertStringIncludes(
      html,
      '<input checked name="group_ids" type="checkbox" value="9"> Weekend',
    );
  });
});
