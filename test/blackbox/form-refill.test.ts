import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { type App, createApp, inProcess } from "#test/blackbox/driver.ts";
import { followed, loggedIn } from "#test/blackbox/settings.ts";
import { describeWithEnv } from "#test-utils/db.ts";

const TYPED = "Remember this description";
const REFUSAL = "Group Name is required";

/** The owner sends the new group form with a description and no name. */
const sendWithoutName = (app: App) =>
  app.submit(
    "/admin/groups/new",
    { description: TYPED, name: "" },
    "/admin/groups",
  );

describeWithEnv("a form that the site refuses", { db: true }, () => {
  test("the next page shows the reason and the text that the owner typed", async () => {
    const app = await loggedIn();
    const page = await followed(app, await sendWithoutName(app));
    expect(page.status).toBe(200);
    expect(page.html).toContain(REFUSAL);
    expect(page.html).toContain(TYPED);
  });

  test("the typed text shows once: a second visit with the same cookies keeps the reason only", async () => {
    const app = await loggedIn();
    const sent = await sendWithoutName(app);
    const again = createApp(inProcess, app.cookieHeader());
    expect((await followed(app, sent)).html).toContain(TYPED);

    const second = await followed(again, sent);
    expect(second.html).toContain(REFUSAL);
    expect(second.html).not.toContain(TYPED);
  });
});
