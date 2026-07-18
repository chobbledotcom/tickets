import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { ErrorCode } from "#shared/logger.ts";
import "#shared/sentry-sdk.ts";
import { captureServerError, initSentry } from "#shared/sentry.ts";
import {
  getSubrequestUsage,
  runWithSubrequestBudget,
} from "#shared/subrequest-budget.ts";
import { withEnv } from "#test-utils/env.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import { resetSentry } from "#test-utils/sentry.ts";

describe("Sentry SDK transport", () => {
  afterEach(resetSentry);

  test("counts one external subrequest per envelope", async () => {
    using _env = withEnv({
      SENTRY_URL: "https://key@bugs.example.test/1",
    });
    using fetchStub = stubFetch(new Response(null, { status: 200 }));

    await runWithSubrequestBudget(async () => {
      expect(await initSentry()).toBe(true);
      await captureServerError({ code: ErrorCode.DB_QUERY });
      expect(getSubrequestUsage()).toEqual({
        database: 0,
        external: 1,
        total: 1,
      });
    });
    expect(fetchStub.calls).toHaveLength(1);
  });
});
