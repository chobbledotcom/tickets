import { fn } from "@std/expect/fn";
import type { ErrorPageFn } from "#routes/admin/settings-helpers.ts";
import type { AuthSession } from "#routes/auth.ts";
import { FormParams } from "#shared/form-data.ts";
import { getAllActivityLog } from "#test-utils/activity-log.ts";

/** Build FormParams from a plain record of form fields. */
export const formFrom = (data: Record<string, string>): FormParams =>
  new FormParams(new URLSearchParams(data));

/** A null AuthSession for handlers that never read the session. */
// deno-lint-ignore no-explicit-any
export const nullSession = null as any as AuthSession;

/** The most recent activity-log message, or "" when the log is empty. */
export const lastLogMessage = async (): Promise<string> => {
  const logs = await getAllActivityLog(10);
  return logs[0]?.message ?? "";
};

/** A fresh spy ErrorPageFn that renders `error: <msg>` with the given status. */
export const makeMockErrorPage = (): ErrorPageFn & ReturnType<typeof fn> =>
  fn(
    (error: string, status: number, _formId: string) =>
      new Response(`error: ${error}`, { status }),
  ) as unknown as ErrorPageFn & ReturnType<typeof fn>;

/** Invoke a settings handler with form `data` + `errorPage` and a null session. */
export const runHandler = (
  handler: (
    form: FormParams,
    errorPage: ErrorPageFn,
    session: AuthSession,
  ) => Response | Promise<Response>,
  data: Record<string, string>,
  errorPage: ErrorPageFn,
): Promise<Response> =>
  Promise.resolve(handler(formFrom(data), errorPage, nullSession));
