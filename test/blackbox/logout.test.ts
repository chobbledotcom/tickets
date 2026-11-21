import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { createApp, inProcess } from "#test/blackbox/driver.ts";
import { describeWithEnv } from "#test-utils/db.ts";

const LOGIN_FORM = 'action="/admin/login"';

describeWithEnv("logging out", { db: true }, () => {
  test("the session cookie from before the logout no longer opens the admin", async () => {
    const app = createApp(inProcess);
    await app.logIn();
    const cookieBefore = app.cookieHeader();
    expect((await app.get("/admin/")).html).not.toContain(LOGIN_FORM);

    const out = await app.submit("/admin/logout");
    expect(out.status).toBe(302);

    const replay = createApp(inProcess, cookieBefore);
    expect((await replay.get("/admin/")).html).toContain(LOGIN_FORM);
    expect((await app.get("/admin/")).html).toContain(LOGIN_FORM);
  });
});
