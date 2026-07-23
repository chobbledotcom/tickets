import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { ErrorCode } from "#shared/logger.ts";
import { reportSiteAssignmentFailure } from "#shared/site-assignment-failure.ts";
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
