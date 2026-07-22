import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { t, withMessageGroups } from "#i18n";
import { ADMIN_AREA_LOADERS } from "#routes/admin/area-loaders.ts";
import { withColdMessages } from "#test-utils/i18n.ts";

test("catalog transfer loads while image copy stays unloaded", () =>
  withColdMessages(async () => {
    const area = ADMIN_AREA_LOADERS.catalogTransfer;

    const handlers = await withMessageGroups(
      area.messageGroupsFor("catalog"),
      area.load,
    );

    expect(handlers["GET /admin/catalog/import"]).toBeInstanceOf(Function);
    expect(() => t("images.column.thumbnail")).toThrow(
      'Missing translation for key "images.column.thumbnail"',
    );
  }));
