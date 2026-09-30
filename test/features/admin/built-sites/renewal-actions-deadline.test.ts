import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import { updateBuiltSiteRenewalState } from "#db/built-sites.ts";
import { addMonthsIso } from "#shared/dates.ts";
import { getAllActivityLog } from "#test-utils/activity-log.ts";
import { expectFlashRedirect } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestBuiltSite } from "#test-utils/db-helpers/built-sites.ts";
import { adminFormPost } from "#test-utils/session.ts";
import {
  findSite,
  renewalSuiteHelpers,
  secretNamesOf,
  siteAction,
} from "./renewal-setup.ts";

const NOW_MS = 1_700_000_000_000;

/** Assert bump-deadline clamps `months` to `expectedMonths` (under fake time). */
const expectBumpClamps = async (
  scriptId: string,
  siteName: string,
  months: string,
  expectedMonths: number,
): Promise<void> => {
  using _fakeTime = new FakeTime(NOW_MS);
  const site = await createTestBuiltSite({
    hostingId: scriptId,
    name: siteName,
  });
  const { response } = await siteAction(site, "bump-deadline", { months });
  expect(response.status).toBe(302);
  const updated = await findSite(site.id);
  expect(updated.readOnlyFrom).toBe(
    addMonthsIso(new Date(NOW_MS).toISOString(), expectedMonths),
  );
};

describeWithEnv(
  "admin built-sites renewal actions: bump-deadline",
  {
    db: true,
    env: { CAN_BUILD_SITES: "true" },
  },
  () => {
    const suite = renewalSuiteHelpers();

    describe("POST /admin/built-sites/:id/bump-deadline", () => {
      test("bumps from current deadline on future-dated site", async () => {
        using _fakeTime = new FakeTime(NOW_MS);
        const site = await createTestBuiltSite({
          hostingId: "6010",
          name: "Bump Future",
        });
        await updateBuiltSiteRenewalState(site.id, {
          readOnlyFrom: new Date(NOW_MS + 10 * 86400000).toISOString(),
        });

        const { response } = await adminFormPost(
          `/admin/built-sites/${site.id}/bump-deadline`,
          { months: "3" },
        );
        await expectFlashRedirect(
          `/admin/built-sites/${site.id}/renewal`,
          "Deadline bumped",
        )(response);

        const updated = await findSite(site.id);
        const expectedBase = new Date(NOW_MS + 10 * 86400000).toISOString();
        expect(updated.readOnlyFrom).toBe(addMonthsIso(expectedBase, 3));
        expect(
          (await getAllActivityLog()).map(({ message }) => message),
        ).toContain("Admin bumped 'Bump Future' deadline by 3 month(s)");
      });

      test("bumps from now on expired site", async () => {
        using _fakeTime = new FakeTime(NOW_MS);
        const site = await createTestBuiltSite({
          hostingId: "6011",
          name: "Bump Expired",
        });
        await updateBuiltSiteRenewalState(site.id, {
          readOnlyFrom: new Date(NOW_MS - 30 * 86400000).toISOString(),
        });

        await adminFormPost(`/admin/built-sites/${site.id}/bump-deadline`, {
          months: "6",
        });

        const updated = await findSite(site.id);
        const expected = addMonthsIso(new Date(NOW_MS).toISOString(), 6);
        expect(updated.readOnlyFrom).toBe(expected);
      });

      test("bumps from now on deadline-less site", async () => {
        using _fakeTime = new FakeTime(NOW_MS);
        const site = await createTestBuiltSite({
          hostingId: "6012",
          name: "Bump No Deadline",
        });

        await adminFormPost(`/admin/built-sites/${site.id}/bump-deadline`, {
          months: "2",
        });

        const updated = await findSite(site.id);
        const expected = addMonthsIso(new Date(NOW_MS).toISOString(), 2);
        expect(updated.readOnlyFrom).toBe(expected);
      });

      test("works without a renewal token (no RENEWAL_URL push)", async () => {
        const site = await createTestBuiltSite({
          hostingId: "6013",
          name: "Bump No Token",
        });
        suite.resetSecretStub();

        const { response } = await adminFormPost(
          `/admin/built-sites/${site.id}/bump-deadline`,
          { months: "1" },
        );
        expect(response.status).toBe(302);

        const secretNames = secretNamesOf(suite.secretStub);
        expect(secretNames).not.toContain("RENEWAL_URL");
      });

      test("clamps months <= 0 to 1", () =>
        expectBumpClamps("6014", "Bump Zero", "0", 1));

      test("clamps months > 120 to 120", () =>
        expectBumpClamps("6015", "Bump Large", "999", 120));

      test("returns error when CDN push fails", async () => {
        const site = await createTestBuiltSite({
          hostingId: "6016",
          name: "Bump CDN Fail",
        });
        await suite.withFailingSecretStub(async () => {
          const { response } = await adminFormPost(
            `/admin/built-sites/${site.id}/bump-deadline`,
            { months: "1" },
          );
          await expectFlashRedirect(
            `/admin/built-sites/${site.id}/renewal`,
            expect.stringContaining("could not be pushed"),
            false,
          )(response);
        });
      });

      test("clamps non-numeric months to 1", () =>
        expectBumpClamps("6017", "Bump NaN", "abc", 1));

      test("treats a hexadecimal month value as zero", () =>
        expectBumpClamps("6018", "Bump Hex", "0x10", 1));
    });
  },
);
