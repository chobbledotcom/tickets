/* jscpd:ignore-start -- imports */
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { ProviderResource } from "#shared/payment-state/resources.ts";
import {
  invalidProviderReadResult,
  makeProviderResourceTransport,
  makeProviderTransportReader,
  providerReadForTransportIssue,
  providerReadValidator,
  transportIssueForError,
} from "#shared/provider-transport.ts";

/* jscpd:ignore-end */

const REQUESTED: ProviderResource = {
  id: "cs_transport",
  kind: "stripe_checkout_session",
  provider: "stripe",
};

type TestIssue = "invalid" | "missing" | "unavailable";

class TestTransportError extends Error {
  constructor(readonly issue: TestIssue | "propagate") {
    super(issue);
  }
}

const transportHarness = (configured = true) => {
  const reports: { context: string; issue: string }[] = [];
  const reader = makeProviderTransportReader<
    { name: string },
    "invalid",
    string
  >({
    classifyError: (error) => {
      if (!(error instanceof TestTransportError)) return "propagate";
      return error.issue === "propagate"
        ? "propagate"
        : { status: error.issue };
    },
    getClient: () => (configured ? { name: "client" } : null),
    reportError: (error, context) => {
      if (!(error instanceof TestTransportError)) {
        throw new Error("Expected a test transport error");
      }
      reports.push({ context, issue: error.issue });
    },
  });
  return { reader, reports };
};

describe("provider transport reader", () => {
  test("does not call a provider when it is not configured", async () => {
    const { reader, reports } = transportHarness(false);
    let called = false;
    const result = await reader(() => {
      called = true;
      return Promise.resolve("unused");
    }, "read");
    expect(result).toEqual({ status: "unavailable" });
    expect(called).toBe(false);
    expect(reports).toEqual([]);
  });

  test("returns a successful provider value", async () => {
    const { reader } = transportHarness();
    await expect(
      reader((client) => Promise.resolve(`${client.name}-value`), "read"),
    ).resolves.toEqual({ status: "found", value: "client-value" });
  });

  for (const [issue, reports] of [
    ["missing", 0],
    ["invalid", 1],
    ["unavailable", 1],
  ] as const) {
    test(`classifies a ${issue} provider result`, async () => {
      const harness = transportHarness();
      const result = await harness.reader(
        () => Promise.reject(new TestTransportError(issue)),
        "payment-read",
      );
      expect(result).toEqual({ status: issue });
      expect(harness.reports).toHaveLength(reports);
      if (reports === 1) {
        expect(harness.reports[0]).toEqual({
          context: "payment-read",
          issue,
        });
      }
    });
  }

  test("propagates provider boundary errors", async () => {
    const harness = transportHarness();
    await expect(
      harness.reader(
        () => Promise.reject(new TestTransportError("propagate")),
        "read",
      ),
    ).rejects.toThrow("propagate");
    expect(harness.reports).toEqual([]);
  });

  test("classifies HTTP not-found separately from the fallback issue", () => {
    const missing = new Response(null, { status: 404 });
    const unavailable = new Response(null, { status: 503 });
    const isMissing = (error: unknown) =>
      error instanceof Response && error.status === 404;
    expect(transportIssueForError(missing, isMissing, "unavailable")).toEqual({
      status: "missing",
    });
    expect(
      transportIssueForError(unavailable, isMissing, "unavailable"),
    ).toEqual({ status: "unavailable" });
  });
});

describe("provider transport adapters", () => {
  test("builds lookup and nullable retrieval from one resource loader", async () => {
    const loads: string[] = [];
    const transport = makeProviderResourceTransport(
      (client: { prefix: string }, id) => {
        loads.push(id);
        return Promise.resolve(`${client.prefix}:${id}`);
      },
      async (load, context: string) => ({
        context,
        value: await load({ prefix: "lookup" }),
      }),
      (load) => load({ prefix: "retrieve" }),
      "resource-read",
    );

    await expect(transport.lookup("one")).resolves.toEqual({
      context: "resource-read",
      value: "lookup:one",
    });
    await expect(transport.retrieve("two")).resolves.toBe("retrieve:two");
    expect(loads).toEqual(["one", "two"]);
  });

  test("maps each unresolved transport result to its exact provider read", () => {
    expect(
      providerReadForTransportIssue({ status: "missing" }, null, REQUESTED),
    ).toEqual({ reason: "not_found", requested: REQUESTED, status: "missing" });
    expect(
      providerReadForTransportIssue({ status: "unavailable" }, null, REQUESTED),
    ).toEqual({
      reason: "provider_unavailable",
      requested: REQUESTED,
      status: "unavailable",
    });
    expect(
      providerReadForTransportIssue({ status: "invalid" }, null, REQUESTED),
    ).toEqual({
      reason: "malformed_response",
      requested: REQUESTED,
      status: "invalid",
    });
  });

  test("binds one requested resource to all validation results", () => {
    const validate = providerReadValidator(REQUESTED, null);
    expect(validate(true, "mismatched_parent")).toBeNull();
    expect(validate(false, "mismatched_parent")).toEqual(
      invalidProviderReadResult(REQUESTED, null, "mismatched_parent"),
    );
  });
});
