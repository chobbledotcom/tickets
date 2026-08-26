/** Direct tests for the email run's report rendering and verdict. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  emailSummaryMarkdown,
  everyLegSkipped,
  failedProviders,
  outcomeLine,
  sentCount,
} from "#scripts/email-sandbox-e2e/report.ts";
import type { EmailLegOutcome } from "#scripts/email-sandbox-e2e/run.ts";

const outcomes: EmailLegOutcome[] = [
  { detail: "single 200, bulk 200", provider: "resend", state: "sent" },
  {
    detail: "POSTMARK_SERVER_TOKEN is not set",
    provider: "postmark",
    state: "skipped",
  },
  {
    detail: "single 403, bulk 403 — bad key",
    provider: "sendgrid",
    state: "failed",
  },
];

describe("outcomeLine", () => {
  test("names the provider, the state word, and the fact", () => {
    expect(outcomeLine(outcomes[0]!)).toBe(
      "resend: ✅ sent — single 200, bulk 200",
    );
    expect(outcomeLine(outcomes[1]!)).toBe(
      "postmark: ⏭️ skipped — POSTMARK_SERVER_TOKEN is not set",
    );
    expect(outcomeLine(outcomes[2]!)).toBe(
      "sendgrid: ❌ failed — single 403, bulk 403 — bad key",
    );
  });
});

describe("emailSummaryMarkdown", () => {
  test("renders one table row per leg", () => {
    expect(emailSummaryMarkdown(outcomes)).toBe(
      [
        "\n## Live email providers\n",
        "provider | outcome | detail",
        "--- | --- | ---",
        "resend | ✅ sent | single 200, bulk 200",
        "postmark | ⏭️ skipped | POSTMARK_SERVER_TOKEN is not set",
        "sendgrid | ❌ failed | single 403, bulk 403 — bad key",
        "",
      ].join("\n"),
    );
  });
});

describe("the verdict helpers", () => {
  test("failedProviders names only the failed legs", () => {
    expect(failedProviders(outcomes)).toEqual(["sendgrid"]);
    expect(failedProviders([outcomes[0]!, outcomes[1]!])).toEqual([]);
  });

  test("everyLegSkipped is true only when nothing ran", () => {
    expect(everyLegSkipped(outcomes)).toBe(false);
    expect(everyLegSkipped([outcomes[1]!])).toBe(true);
  });

  test("sentCount counts the legs that reached a provider", () => {
    expect(sentCount(outcomes)).toBe(1);
    expect(sentCount([outcomes[1]!, outcomes[2]!])).toBe(0);
  });
});
