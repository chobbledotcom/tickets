/** The checks that stop a bad group save. */

import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import {
  soldHiddenPackageError,
  validateGroupWithPackage,
} from "#shared/records/groups.ts";
import {
  groupInput,
  soldPackage,
} from "#test/features/admin/groups/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createGroupOfOneChild,
  createHiddenPackageGroup,
  createTestGroup,
} from "#test-utils/db-helpers/groups.ts";

describeWithEnv("admin group validation", { db: true }, () => {
  test("rejects a name another group already uses", async () => {
    const existing = await createTestGroup({ name: "Taken name" });

    expect(
      await validateGroupWithPackage(await groupInput({ name: existing.name })),
    ).toBe(t("error.name_in_use"));
  });

  test("rejects a slug another group already uses", async () => {
    const existing = await createTestGroup({ name: "Slug owner" });

    expect(
      await validateGroupWithPackage(await groupInput({ slug: existing.slug })),
    ).toBe(t("error.slug_in_use_group"));
  });

  test("accepts a group whose name and slug are free", async () => {
    expect(await validateGroupWithPackage(await groupInput())).toBeNull();
  });

  test("accepts the group's own name and slug when editing it", async () => {
    const group = await createTestGroup({ name: "Self edit" });

    expect(
      await validateGroupWithPackage(
        await groupInput({ name: group.name, slug: group.slug }),
        group.id,
      ),
    ).toBeNull();
  });

  test("rejects making a group a package when a member cannot be one", async () => {
    const group = await createGroupOfOneChild({
      child: "Package child",
      group: "Would be package",
      parent: "Package parent",
    });

    const error = await validateGroupWithPackage(
      await groupInput({ isPackage: true, name: group.name, slug: group.slug }),
      group.id,
    );
    assertStringIncludes(error ?? "", "Package child");
  });

  test("a visible package with no bookings can be un-packaged", async () => {
    const group = await createTestGroup({ isPackage: true, name: "Visible" });

    expect(await soldHiddenPackageError(group.id)).toBeNull();
  });

  test("a hidden package with no bookings can be un-packaged", async () => {
    const group = await createHiddenPackageGroup("Hidden unsold");

    expect(await soldHiddenPackageError(group.id)).toBeNull();
  });

  test("a plain group is never blocked by the hidden-package check", async () => {
    const group = await createTestGroup({ name: "Plain" });

    expect(await soldHiddenPackageError(group.id)).toBeNull();
  });

  test("a hidden package with sold tickets cannot be un-packaged", async () => {
    const group = await soldPackage("Hidden sold", true);

    expect(await soldHiddenPackageError(group.id)).toBe(
      t("error.sold_hidden_package"),
    );
  });

  test("a visible package with sold tickets can be un-packaged", async () => {
    const group = await soldPackage("Visible sold", false);

    expect(await soldHiddenPackageError(group.id)).toBeNull();
  });

  test("rejects a name past the text box limit", async () => {
    expect(
      await validateGroupWithPackage(
        await groupInput({ name: "g".repeat(251) }),
      ),
    ).toBe("Name must be 250 characters or fewer");
  });

  test("a sold hidden package cannot be un-packaged by an edit", async () => {
    const group = await soldPackage("Hidden leaving", true);

    expect(
      await validateGroupWithPackage(
        await groupInput({
          isPackage: false,
          name: group.name,
          slug: group.slug,
        }),
        group.id,
      ),
    ).toBe(t("error.sold_hidden_package"));
  });

  test("a sold hidden package may stay a package", async () => {
    const group = await soldPackage("Hidden staying", true);

    expect(
      await validateGroupWithPackage(
        await groupInput({
          isPackage: true,
          name: group.name,
          slug: group.slug,
        }),
        group.id,
      ),
    ).toBeNull();
  });
});
