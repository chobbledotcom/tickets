import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { createActionHandler } from "#routes/admin/actions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { mockFormRequest } from "#test-utils/mocks.ts";
import { testCookie, testCsrfToken } from "#test-utils/session.ts";

describeWithEnv("admin action success cookie", { db: true }, () => {
  test("adds the configured cookie to a successful response", async () => {
    const cookie = await testCookie();
    const csrfToken = await testCsrfToken();
    const handler = createActionHandler({
      auth: "owner",
      cookie: () => "restore_session=; Max-Age=0; Path=/",
      execute: () => Promise.resolve(),
      message: "Cookie action completed",
      successRedirect: "/admin/test-cookie",
    });

    const response = await handler(
      mockFormRequest("/admin/test-cookie", { csrf_token: csrfToken }, cookie),
    );

    expect(response.headers.get("set-cookie")).toContain(
      "restore_session=; Max-Age=0; Path=/",
    );
  });
});
