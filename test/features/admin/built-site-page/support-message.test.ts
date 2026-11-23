/** The built-site page's own pieces: the guide link under every tab and the
 * Support message tab's picture table. */

import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { supportMessageApi } from "#shared/site-support-message.ts";
import { makeImage } from "#test-utils/admin-images.ts";
import {
  expectIncludesAll,
  followRedirectWithFlash,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestBuiltSite } from "#test-utils/db-helpers/built-sites.ts";
import { withEnv } from "#test-utils/env.ts";
import { adminFormPost, adminGet, testCookie } from "#test-utils/session.ts";

/** Make the support-message read answer with this error. */
const failingRead = (error: string) =>
  stub(supportMessageApi, "readSupportMessage", () =>
    Promise.resolve({ error, ok: false as const }),
  );

/** Make the support-message write answer with this error. */
const failingSet = (error: string) =>
  stub(supportMessageApi, "setSupportMessage", () =>
    Promise.resolve({ error, ok: false as const }),
  );

describeWithEnv(
  "built-site page",
  { db: true, env: { BUNNY_API_KEY: "k", CAN_BUILD_SITES: "true" } },
  () => {
    test("links the built sites guide section under the page", async () => {
      const site = await createTestBuiltSite({
        hostingId: "8300",
        name: "Guided Site",
      });

      const html = await (
        await adminGet(`/admin/built-sites/${site.id}`)
      ).text();

      expectIncludesAll(html, [
        'class="guide-footer"',
        'href="/admin/guide#built-sites"',
        "Built sites guide",
      ]);
    });

    test("resolves a refused draft's picture when the follow-up read fails", async () => {
      const site = await createTestBuiltSite({
        hostingId: "8301",
        name: "Draft Pictures",
      });
      const image = await makeImage("DraftPoster");
      using _read = failingRead("Read support message failed (500): outage");
      using _set = failingSet("Set support message failed (500): try later");
      const cookie = await testCookie();
      const { response } = await adminFormPost(
        `/admin/built-sites/${site.id}/support-message`,
        { supportMessage: `![DraftPoster](img#${image.id})` },
      );
      // Only a read-only viewer sees the draft rendered as markdown.
      using _env = withEnv({ READ_ONLY_FROM: "2020-01-01T00:00:00.000Z" });

      const followed = await followRedirectWithFlash(
        response,
        handleRequest,
        cookie,
      );
      const html = await followed.text();

      expect(followed.status).toBe(200);
      assertStringIncludes(
        html,
        `<img src="/image/${image.filename}" alt="DraftPoster">`,
      );
      assert(!html.includes("img#"));
    });
  },
);
