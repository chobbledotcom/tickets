import * as Sentry from "@sentry/deno";

/** Detach the global SDK client so Sentry state cannot leak between tests. */
export const resetSentry = (): void => {
  const scopes = [
    Sentry.getCurrentScope(),
    Sentry.getGlobalScope(),
    Sentry.getIsolationScope(),
  ];
  for (const scope of scopes) scope.setClient(undefined);
};
