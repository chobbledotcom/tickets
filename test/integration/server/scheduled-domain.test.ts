import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { executeWithoutCacheInvalidation } from "#db/client.ts";
import { handleScheduledRequest } from "#routes/scheduled.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { stubFetchEachTest } from "#test-utils/fetch-stub.ts";
import {
  expectScheduledResponse,
  scheduledAuthorization,
} from "#test-utils/scheduled.ts";

describeWithEnv(
  "server > scheduled > effective domain",
  {
    db: true,
    env: {
      NTFY_URL: "https://ntfy.example/tickets",
      SCHEDULED_TASK_KEY: "test-scheduled-key",
    },
  },
  () => {
    const fetch = stubFetchEachTest(() => new Response());

    test("a failed scheduled request reports its own host, not the default", async () => {
      // The seed must run inside the scheduled request's context: the failure
      // report's ntfy title reads the effective domain, and a seed made
      // outside the context is lost. Dropping the settings table makes
      // initDb fail before any domain load, the window a mid-handler seed
      // never covers.
      await executeWithoutCacheInvalidation("DROP TABLE settings", []);
      const response = await handleScheduledRequest(
        new Request("https://scheduled-host.example/scheduled", {
          headers: scheduledAuthorization("test-scheduled-key"),
          method: "POST",
        }),
      );
      await expectScheduledResponse(response, 503);
      const [url, options] = fetch.calls[0]!.args as [string, RequestInit];
      expect(url).toBe("https://ntfy.example/tickets");
      expect((options.headers as Record<string, string>).Title).toBe(
        "scheduled-host.example error",
      );
    });
  },
);
