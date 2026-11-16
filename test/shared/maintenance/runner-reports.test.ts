import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { ErrorCode, logError } from "#shared/logger.ts";
import { defineMaintenanceTasks } from "#shared/maintenance/definition.ts";
import { maintenance } from "#shared/maintenance/runner.ts";
import {
  countSubrequest,
  runWithSubrequestBudget,
} from "#shared/subrequest-budget.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { withEnv } from "#test-utils/env.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import { withRequestContext } from "#test-utils/request-context.ts";
import { maintenanceDeclaration as declaration } from "./fixtures.ts";

describeWithEnv("maintenance runner error reports", { db: true }, () => {
  test("keeps an error report out of the allowance of its task", async () => {
    using _env = withEnv({ NTFY_URL: "https://ntfy.test/alerts" });
    using _console = stub(console, "error", () => {});
    using alerts = stubFetch(new Response());
    const spent: string[] = [];
    const tasks = defineMaintenanceTasks([
      declaration(
        "reports_then_reads",
        async () => {
          logError({ code: ErrorCode.STRIPE_SUBSCRIPTION, detail: "refused" });
          for (const read of ["first read", "second read"]) {
            // A provider read yields, so a report sent at once goes first.
            await new Promise((resolve) => setTimeout(resolve, 0));
            countSubrequest("external", read);
            spent.push(read);
          }
        },
        { maxExternalCalls: 2 },
      ),
    ]);

    await withRequestContext(() =>
      runWithSubrequestBudget(() => maintenance.run(tasks)),
    );

    expect(spent).toEqual(["first read", "second read"]);
    expect(alerts.calls.map(({ args }) => String(args[0]))).toEqual([
      "https://ntfy.test/alerts",
    ]);
  });
});
