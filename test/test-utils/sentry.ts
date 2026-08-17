import * as Sentry from "@sentry/deno";
import type { Stub } from "@std/testing/mock";

/** Read the envelope body sent to the configured Sentry endpoint. */
export const sentryRequestBody = (calls: Stub["calls"]): string => {
  const sentryCall = calls.find((call) =>
    String(call.args[0]).includes("bugs.example.test"),
  );
  if (sentryCall === undefined) throw new Error("Sentry was not called");
  const options = sentryCall.args[1] as RequestInit;
  return typeof options.body === "string"
    ? options.body
    : new TextDecoder().decode(options.body as Uint8Array);
};

/** Detach the global SDK client so Sentry state cannot leak between tests. */
export const resetSentry = (): void => {
  Sentry.getCurrentScope().setClient(undefined);
  Sentry.getGlobalScope().setClient(undefined);
  Sentry.getIsolationScope().setClient(undefined);
};
