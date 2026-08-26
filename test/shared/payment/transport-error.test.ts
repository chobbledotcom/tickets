import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  connectionReasonOf,
  providerDetail,
  rejectedBuyerFieldOf,
  transportError,
  transportFactsOf,
} from "#payment/transport-error.ts";

describe("provider transport errors", () => {
  describe("the facts each failure proves", () => {
    test("takes the status as the whole verdict when the provider answered", () => {
      const error = transportError.answered(providerDetail.sumup(), 409);

      expect(error.facts).toEqual({ statusCode: 409 });
      expect(error.message).toBe("SumUp answered. Status code: 409");
    });

    test("keeps a provider's own wording when it passes one", () => {
      const error = transportError.answered(
        providerDetail.stripe(),
        402,
        "Your card was declined",
      );

      expect(error.message).toBe("Your card was declined");
      expect(error.facts).toEqual({ statusCode: 402 });
    });

    // An unreadable answer stays unreadable even when a status came with it.
    // The read and refund meanings take the status; checkout needs to know
    // the answer itself could not be read, so both facts are set.
    test("marks an unusable answer malformed whether or not it had a status", () => {
      expect(transportError.unusable(providerDetail.square()).facts).toEqual({
        malformed: true,
      });
      expect(
        transportError.unusable(providerDetail.stripe(), 502).facts,
      ).toEqual({ malformed: true, statusCode: 502 });
    });

    // A provider that hands back a blank message has said nothing, so our
    // own wording is used rather than an error with no message at all.
    test("falls back to our wording when a provider's is blank", () => {
      expect(
        transportError.answered(providerDetail.stripe(), 402, "").message,
      ).toBe("Stripe answered. Status code: 402");
      expect(
        transportError.unusable(providerDetail.stripe(), 502, "").message,
      ).toBe("Stripe returned an answer we could not read");
    });

    // Our own wording reaches the settings pages, so it names the provider
    // the way the operator knows it rather than by its identifier.
    test("says which way a provider went unreachable", () => {
      expect(
        transportError.unreachable(providerDetail.square(), "timeout").message,
      ).toBe("Square did not answer in time");
      expect(
        transportError.unreachable(providerDetail.sumup(), "network_error")
          .message,
      ).toBe("SumUp could not be reached");
    });

    test("names why a provider could not be reached", () => {
      expect(
        transportError.unreachable(providerDetail.square(), "timeout").facts,
      ).toEqual({ connectionReason: "timeout" });
      expect(
        transportError.unreachable(providerDetail.sumup(), "network_error")
          .facts,
      ).toEqual({ connectionReason: "network_error" });
    });
  });

  describe("what a provider adds of its own", () => {
    test("reads the provider from the detail rather than storing it twice", () => {
      for (const detail of [
        providerDetail.square(),
        providerDetail.stripe(),
        providerDetail.sumup(),
      ]) {
        expect(transportError.answered(detail, 500).provider).toBe(
          detail.provider,
        );
      }
    });

    test("carries Stripe's code, kind and request id", () => {
      const error = transportError.answered(
        providerDetail.stripe({
          code: "resource_missing",
          requestId: "req_1",
          type: "invalid_request_error",
        }),
        404,
      );

      expect(error.detail).toEqual({
        code: "resource_missing",
        provider: "stripe",
        requestId: "req_1",
        type: "invalid_request_error",
      });
    });

    test("reports the buyer field only the provider that named one", () => {
      const named = transportError.answered(
        providerDetail.square("email"),
        400,
      );
      const unnamed = transportError.answered(providerDetail.square(), 400);
      const other = transportError.answered(providerDetail.stripe(), 400);

      expect(rejectedBuyerFieldOf(named)).toBe("email");
      expect(rejectedBuyerFieldOf(unnamed)).toBeNull();
      expect(rejectedBuyerFieldOf(other)).toBeNull();
    });
  });

  describe("reading a caught error", () => {
    test("hands back the facts of a transport failure", () => {
      const error = transportError.answered(providerDetail.square(), 404);

      expect(transportFactsOf(error)).toEqual({ statusCode: 404 });
    });

    // An error we did not raise is a bug in our own code. Claiming it as a
    // provider failure would report an outage the provider never had.
    test("claims nothing for an error the transport did not raise", () => {
      expect(transportFactsOf(new Error("mapper bug"))).toBeUndefined();
      expect(
        transportFactsOf(new TypeError("connection reset")),
      ).toBeUndefined();
      expect(transportFactsOf("not an error")).toBeUndefined();
    });

    test("stays an Error, so an unclaimed throw still reads normally", () => {
      const error = transportError.unreachable(
        providerDetail.sumup(),
        "timeout",
      );

      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe("ProviderTransportError");
    });
  });

  describe("classifying a fetch that never answered", () => {
    // Every provider aborts through `AbortSignal.timeout`, so an abort is a
    // timeout whatever name the runtime gives it.
    test("reads both abort names as a timeout", () => {
      for (const name of ["AbortError", "TimeoutError"]) {
        expect(connectionReasonOf(new DOMException("stopped", name))).toBe(
          "timeout",
        );
      }
    });

    test("reads a failed fetch as a network failure", () => {
      expect(connectionReasonOf(new TypeError("connection reset"))).toBe(
        "network_error",
      );
    });

    test("refuses to classify anything else", () => {
      expect(connectionReasonOf(new Error("mapper bug"))).toBeUndefined();
      expect(connectionReasonOf(new RangeError("bad index"))).toBeUndefined();
      expect(
        connectionReasonOf(new DOMException("gone", "NotFoundError")),
      ).toBeUndefined();
      expect(connectionReasonOf(undefined)).toBeUndefined();
    });
  });
});
