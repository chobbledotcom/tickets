import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import { contentWriteOrError } from "#routes/admin/site-content.ts";
import { runWithFlashContext } from "#shared/flash-context.ts";
import { errorResult, okResult } from "#shared/result.ts";
import {
  expectErrorFlash,
  expectFlash,
  expectRedirect,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestNewsPost } from "#test-utils/db-helpers/misc.ts";
import { adminFormPost, adminGet } from "#test-utils/session.ts";

describe("admin site content write outcomes", () => {
  test("returns the saved value", () => {
    expect(contentWriteOrError(okResult("saved"), "/edit", "Taken")).toBe(
      "saved",
    );
  });

  test("returns not found when the row disappeared", () => {
    const response = contentWriteOrError(
      errorResult("notFound"),
      "/edit",
      "Taken",
    );
    expect(response).toBeInstanceOf(Response);
    if (!(response instanceof Response)) throw new Error("expected response");
    expect(response.status).toBe(404);
  });

  test("redirects a slug conflict to the form", () => {
    const response = runWithFlashContext(() =>
      contentWriteOrError(errorResult("slugTaken"), "/edit", "Already used"),
    );
    expect(response).toBeInstanceOf(Response);
    if (!(response instanceof Response)) throw new Error("expected response");
    expectErrorFlash(response, "Already used");
  });
});

/** News is the smallest of the two content types built from this lifecycle, so
 * it stands in for the shared routes here. */
describeWithEnv("the routes a site content type gets", { db: true }, () => {
  test("opens a record on its edit form", async () => {
    const post = await createTestNewsPost("Opening times");

    const response = await adminGet(`/admin/site/news/${post.id}`);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain(
      `action="/admin/site/news/${post.id}/edit"`,
    );
  });

  test("says plainly that a new record was created", async () => {
    const { response } = await adminFormPost("/admin/site/news", {
      name: "Fresh News",
    });

    expectRedirect(response, /^\/admin\/site\/news\/\d+\/edit\?flash=/);
    expectFlash(response, t("news.created"), true);
  });
});
