import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { type Stub, stub } from "@std/testing/mock";
import { settings } from "#db/settings.ts";
import { getEffectiveDomain } from "#shared/config.ts";
import { hostEmail } from "#shared/email.ts";
import { ErrorCode } from "#shared/logger.ts";
import {
  reportOutOfStockBuyers,
  reportSiteAssignmentFailure,
} from "#shared/site-assignment-failure.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { validEmail } from "#test-utils/email.ts";
import { withEnv } from "#test-utils/env.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";

const message = "Site assignment is not configured.";

describe("site assignment failure reporting", () => {
  test("uses the matching error code for every notification", () => {
    using _env = withEnv({ NTFY_URL: "https://ntfy.test/site-assignment" });
    using fetchStub = stubFetch(() => new Response());
    using _error = stub(console, "error", () => {});

    reportSiteAssignmentFailure(
      { message, ok: false, reason: "builder_disabled" },
      1,
    );
    reportSiteAssignmentFailure(
      { listingId: 71, message, ok: false, reason: "initial_months" },
      2,
    );
    reportSiteAssignmentFailure(
      { message, ok: false, reason: "missing_tier" },
      3,
    );

    expect(fetchStub.calls.map(({ args }) => args[1].body)).toEqual([
      ErrorCode.CONFIG_MISSING,
      ErrorCode.DATA_INVALID,
      ErrorCode.CONFIG_MISSING,
    ]);
  });

  test("includes the listing ID in an invalid-months log", () => {
    using _env = withEnv({ NTFY_URL: undefined });
    using errorStub = stub(console, "error", () => {});

    reportSiteAssignmentFailure(
      { listingId: 71, message, ok: false, reason: "initial_months" },
      2,
    );

    expect(errorStub.calls[0]?.args[0]).toBe(
      '[Error] E_DATA_INVALID detail="Site assignment blocked (initial_months, 2 entries skipped), listing #71"',
    );
  });

  test("omits a listing ID from non-listing failure logs", () => {
    using _env = withEnv({ NTFY_URL: undefined });
    using errorStub = stub(console, "error", () => {});

    reportSiteAssignmentFailure(
      { message, ok: false, reason: "builder_disabled" },
      1,
    );
    reportSiteAssignmentFailure(
      { message, ok: false, reason: "missing_tier" },
      3,
    );

    expect(errorStub.calls.map(({ args }) => args[0])).toEqual([
      '[Error] E_CONFIG_MISSING detail="Site assignment blocked (builder_disabled, 1 entries skipped)"',
      '[Error] E_CONFIG_MISSING detail="Site assignment blocked (missing_tier, 3 entries skipped)"',
    ]);
  });
});

const JANE = "One Month Site — Jane Doe (jane@example.com)";
const SAM = "Second Plan — Sam Roe (sam@example.com)";

/** The warning email's whole body, spelled out here so any word change in
 * the app's own message fails these tests. */
const expectedWarningEmail = (buyerLines: readonly string[]) => {
  const sitesUrl = `https://${getEffectiveDomain()}/admin/built-sites`;
  return {
    html:
      "<p>A site plan was sold, and no site was available to assign. " +
      "The booking and its payment stand, and these buyers have no site yet:</p>" +
      `<ul>${buyerLines.map((line) => `<li>${line}</li>`).join("")}</ul>` +
      `<p>Add sites on the <a href="${sitesUrl}">built-sites page</a>, ` +
      "then resend the notification for each buyer from their attendee page.</p>",
    text:
      "A site plan was sold, and no site was available to assign.\n\n" +
      "The booking and its payment stand, and these buyers have no site yet:\n\n" +
      `${buyerLines.map((line) => `- ${line}`).join("\n")}\n\n` +
      `Add sites on the built-sites page (${sitesUrl}), then resend the ` +
      "notification for each buyer from their attendee page.",
  };
};

describeWithEnv("empty site pool reporting", { db: true }, () => {
  let fetchStub: Stub;
  let errorSpy: Stub;

  beforeEach(async () => {
    fetchStub = stubFetch(() => new Response());
    errorSpy = stub(console, "error", () => {});
    await settings.update.businessEmail("biz@example.com");
    hostEmail.setOverride({
      apiKey: "re_test",
      fromAddress: validEmail("host@example.com"),
      provider: "resend",
    });
  });

  afterEach(() => {
    fetchStub.restore();
    errorSpy.restore();
    hostEmail.resetOverride();
  });

  test("warns the business email and pushes the incident", async () => {
    using _env = withEnv({ NTFY_URL: "https://ntfy.test/site-assignment" });

    await reportOutOfStockBuyers([
      {
        attendee: { email: "jane@example.com", name: "Jane Doe" },
        listingName: "One Month Site",
      },
      {
        attendee: { email: "sam@example.com", name: "Sam Roe" },
        listingName: "Second Plan",
      },
    ]);

    // The ntfy ping fires before the warning email; both name the incident.
    expect(fetchStub.calls.length).toBe(2);
    expect(fetchStub.calls[0]!.args[1].body).toBe(ErrorCode.SITE_ASSIGNMENT);
    const logLine = String(errorSpy.calls[0]!.args[0]);
    expect(logLine).toContain("2 plan buyer(s) got no site");
    expect(logLine).toContain("plans: One Month Site + Second Plan");

    const body = JSON.parse(fetchStub.calls[1]!.args[1].body);
    expect(body.subject).toBe("A site plan sold with no site available");
    expect(body.to).toEqual(["biz@example.com"]);
    expect(body.html).toBe(expectedWarningEmail([JANE, SAM]).html);
    expect(body.text).toBe(expectedWarningEmail([JANE, SAM]).text);
  });

  test("warns with one buyer's line when the pool serves all but one", async () => {
    using _env = withEnv({ NTFY_URL: undefined });

    await reportOutOfStockBuyers([
      {
        attendee: { email: "jane@example.com", name: "Jane Doe" },
        listingName: "One Month Site",
      },
    ]);

    expect(fetchStub.calls.length).toBe(1);
    const body = JSON.parse(fetchStub.calls[0]!.args[1].body);
    expect(body.html).toBe(expectedWarningEmail([JANE]).html);
    expect(body.text).toBe(expectedWarningEmail([JANE]).text);
  });

  test("skips the email when no business email is configured", async () => {
    using _env = withEnv({ NTFY_URL: "https://ntfy.test/site-assignment" });
    await settings.update.businessEmail("");

    await reportOutOfStockBuyers([
      {
        attendee: { email: "jane@example.com", name: "Jane Doe" },
        listingName: "One Month Site",
      },
    ]);

    // The ntfy ping and the log entry stand alone: no address to send to.
    expect(fetchStub.calls.length).toBe(1);
    expect(fetchStub.calls[0]!.args[1].body).toBe(ErrorCode.SITE_ASSIGNMENT);
  });

  test("sends nothing and pings nobody when no buyer was missed", async () => {
    using _env = withEnv({ NTFY_URL: "https://ntfy.test/site-assignment" });

    await reportOutOfStockBuyers([]);

    expect(fetchStub.calls.length).toBe(0);
    expect(errorSpy.calls.length).toBe(0);
  });
});
