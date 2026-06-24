import { expect } from "@std/expect";
import { fn } from "@std/expect/fn";
import { beforeEach, it as test } from "@std/testing/bdd";
import type { ErrorPageFn } from "#routes/admin/settings-helpers.ts";
import { toggleHandler } from "#routes/admin/settings-helpers.ts";
import { describeWithEnv, expectFlash, expectRedirect } from "#test-utils";
import {
  lastLogMessage,
  makeMockErrorPage,
  runHandler,
} from "#test-utils/settings-handlers.ts";

/** A toggleHandler for "My feature" with a spy save, plus that spy. */
const makeToggle = (
  overrides: Partial<Parameters<typeof toggleHandler>[0]> = {},
) => {
  const saveFn = fn(() => Promise.resolve());
  const handler = toggleHandler({
    field: "my_toggle",
    formId: "settings-toggle",
    label: "My feature",
    save: saveFn as (v: boolean) => Promise<void>,
    ...overrides,
  });
  return { handler, saveFn };
};

describeWithEnv("toggleHandler", { db: true }, () => {
  let mockErrorPage: ErrorPageFn & ReturnType<typeof fn>;

  beforeEach(() => {
    mockErrorPage = makeMockErrorPage();
  });

  test("saves true and logs 'enabled' when field is 'true'", async () => {
    const { handler, saveFn } = makeToggle();
    const res = await runHandler(handler, { my_toggle: "true" }, mockErrorPage);

    expectRedirect(res, "/admin/settings");
    expect(saveFn).toHaveBeenCalledWith(true);
    expect(await lastLogMessage()).toBe("My feature enabled");
    expectFlash(res, "My feature enabled");
  });

  test("saves false and logs 'disabled' when field is 'false'", async () => {
    const { handler, saveFn } = makeToggle();
    const res = await runHandler(
      handler,
      { my_toggle: "false" },
      mockErrorPage,
    );

    expectRedirect(res, "/admin/settings");
    expect(saveFn).toHaveBeenCalledWith(false);
    expect(await lastLogMessage()).toBe("My feature disabled");
    expectFlash(res, "My feature disabled");
  });

  test("treats missing field as false (unchecked checkbox)", async () => {
    // HTML checkboxes don't submit when unchecked, so the field may be absent
    const { handler, saveFn } = makeToggle();
    await runHandler(handler, {}, mockErrorPage);
    expect(saveFn).toHaveBeenCalledWith(false);
  });

  test("redirects to /admin/settings-advanced when advanced is true", async () => {
    const { handler } = makeToggle({ advanced: true });
    const res = await runHandler(handler, { my_toggle: "true" }, mockErrorPage);
    expectRedirect(res, "/admin/settings-advanced");
  });
});
