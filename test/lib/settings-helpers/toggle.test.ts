import { expect } from "@std/expect";
import { fn } from "@std/expect/fn";
import { beforeEach, it as test } from "@std/testing/bdd";
import { getAllActivityLog } from "#lib/db/activityLog.ts";
import { FormParams } from "#lib/form-data.ts";
import type { ErrorPageFn } from "#routes/admin/settings-helpers.ts";
import { toggleHandler } from "#routes/admin/settings-helpers.ts";
import type { AuthSession } from "#routes/utils.ts";
import { describeWithEnv, expectFlash, expectRedirect } from "#test-utils";

const formFrom = (data: Record<string, string>): FormParams =>
  new FormParams(new URLSearchParams(data));

// deno-lint-ignore no-explicit-any
const nullSession = null as any as AuthSession;

const lastLogMessage = async (): Promise<string> => {
  const logs = await getAllActivityLog(10);
  return logs[0]?.message ?? "";
};

describeWithEnv("toggleHandler", { db: true }, () => {
  let mockErrorPage: ErrorPageFn & ReturnType<typeof fn>;

  beforeEach(() => {
    mockErrorPage = fn(
      (error: string, status: number, _formId: string) =>
        new Response(`error: ${error}`, { status }),
    ) as unknown as ErrorPageFn & ReturnType<typeof fn>;
  });

  test("saves true and logs 'enabled' when field is 'true'", async () => {
    const saveFn = fn(() => Promise.resolve());
    const handler = toggleHandler({
      formId: "settings-toggle",
      field: "my_toggle",
      label: "My feature",
      save: saveFn as (v: boolean) => Promise<void>,
    });

    const res = await handler(
      formFrom({ my_toggle: "true" }),
      mockErrorPage,
      nullSession,
    );

    expectRedirect(res, "/admin/settings");
    expect(saveFn).toHaveBeenCalledWith(true);
    expect(await lastLogMessage()).toBe("My feature enabled");
    expectFlash(res, "My feature enabled");
  });

  test("saves false and logs 'disabled' when field is 'false'", async () => {
    const saveFn = fn(() => Promise.resolve());
    const handler = toggleHandler({
      formId: "settings-toggle",
      field: "my_toggle",
      label: "My feature",
      save: saveFn as (v: boolean) => Promise<void>,
    });

    const res = await handler(
      formFrom({ my_toggle: "false" }),
      mockErrorPage,
      nullSession,
    );

    expectRedirect(res, "/admin/settings");
    expect(saveFn).toHaveBeenCalledWith(false);
    expect(await lastLogMessage()).toBe("My feature disabled");
    expectFlash(res, "My feature disabled");
  });

  test("treats missing field as false (unchecked checkbox)", async () => {
    // HTML checkboxes don't submit when unchecked, so the field may be absent
    const saveFn = fn(() => Promise.resolve());
    const handler = toggleHandler({
      formId: "settings-toggle",
      field: "my_toggle",
      label: "My feature",
      save: saveFn as (v: boolean) => Promise<void>,
    });

    await handler(formFrom({}), mockErrorPage, nullSession);

    expect(saveFn).toHaveBeenCalledWith(false);
  });

  test("redirects to /admin/settings-advanced when advanced is true", async () => {
    const handler = toggleHandler({
      formId: "settings-toggle",
      field: "my_toggle",
      label: "My feature",
      advanced: true,
      save: () => Promise.resolve(),
    });

    const res = await handler(
      formFrom({ my_toggle: "true" }),
      mockErrorPage,
      nullSession,
    );

    expectRedirect(res, "/admin/settings-advanced");
  });
});
