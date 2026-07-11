import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { signCsrfToken } from "#shared/csrf.ts";
import type { AttributeWithOptions } from "#shared/db/attributes.ts";
import {
  adminAttributePage,
  adminAttributesPage,
} from "#templates/admin/attributes.tsx";
import { setTestEnv, setupTestEncryptionKey } from "#test-utils/env.ts";

const SESSION = { adminLevel: "owner" as const };
const ATTRIBUTE: AttributeWithOptions = {
  id: 1,
  name: "Colour",
  options: [
    { attribute_id: 1, id: 10, sort_order: 0, text: "Red" },
    { attribute_id: 1, id: 11, sort_order: 1, text: "Blue" },
  ],
  sort_order: 0,
};

beforeAll(async () => {
  setupTestEncryptionKey();
  await signCsrfToken();
});

describe("attribute pages in read-only mode", () => {
  test("keeps the list readable without create or reorder controls", () => {
    const restore = setTestEnv({ READ_ONLY_FROM: "2020-01-01T00:00:00.000Z" });
    try {
      const html = adminAttributesPage([ATTRIBUTE], SESSION);
      expect(html).toContain("Colour");
      expect(html).toContain('href="/admin/attributes/1"');
      expect(html).not.toContain('id="new-attribute"');
      expect(html).not.toContain("/admin/attributes/1/move-");
    } finally {
      restore();
    }
  });

  test("keeps details readable without edit or delete controls", () => {
    const restore = setTestEnv({ READ_ONLY_FROM: "2020-01-01T00:00:00.000Z" });
    try {
      const html = adminAttributePage(ATTRIBUTE, SESSION, undefined, {
        listingCounts: new Map([[10, 2]]),
        listings: [],
      });
      expect(html).toContain("Red");
      expect(html).toContain('<td class="col-quantity">2</td>');
      expect(html).not.toContain('action="/admin/attributes/1/edit"');
      expect(html).not.toContain("/admin/attributes/1/options/10/edit");
      expect(html).not.toContain("/admin/attributes/1/delete");
      expect(html).not.toContain("/options/10/move-");
    } finally {
      restore();
    }
  });
});
