import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { CLAIM_MIRROR } from "#payment/admit-move.ts";
import {
  assertAdminHtml,
  cachedAdminPage,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { plantPaymentRow } from "#test-utils/joint-state.ts";
import { plantSumupRecoveryRow } from "#test-utils/sumup.ts";

describeWithEnv("server (admin schema map)", { db: true }, () => {
  const page = cachedAdminPage("/admin/schema");

  describe("GET /admin/schema", () => {
    testRequiresAuth("/admin/schema");

    test("renders every machine section with its diagram data", async () => {
      await page(
        "<h1>System map</h1>",
        'data-schema-atlas-machine="refund"',
        'data-schema-atlas-machine="review"',
        'data-schema-atlas-machine="row"',
        'id="schema-atlas-data"',
      );
    });

    test("answers the map question in the static list", async () => {
      const html = await page("Your decision needed: some money is back");
      // The one-exit owner decision shows exactly its own way forward.
      expect(html).toContain("You confirm the money came back → Money back");
      // The page names no real payment anywhere.
      expect(html).not.toMatch(/\/admin\/privacy\/refunds\/\d+/);
    });

    test("renders the live check with a clean answer", async () => {
      await page(
        'id="schema-check"',
        "Live check",
        "All stored payment records fit the rules.",
      );
    });

    test("lists a stored impossible combination with its record id", async () => {
      await plantPaymentRow("cs_atlas_seam", "ref_atlas_seam", CLAIM_MIRROR);
      await assertAdminHtml(
        "/admin/schema",
        "A job holds this row, but its payment has no charge record.",
        "<code>cs_atlas_seam</code>",
      );
    });

    test("lists an unknown SumUp state with its record id", async () => {
      await plantSumupRecoveryRow("co_atlas_unknown", "abandoned", null);

      await assertAdminHtml(
        "/admin/schema",
        "A SumUp recovery record has a state this site does not know.",
        "<code>idx_co_atlas_unknown</code>",
        "<code>abandoned</code>",
      );
    });
  });
});
