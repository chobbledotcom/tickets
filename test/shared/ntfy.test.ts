import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { type Stub, spy } from "@std/testing/mock";
import { ErrorCode } from "#shared/logger.ts";
import { sendNtfyError } from "#shared/ntfy.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";

describeWithEnv("ntfy", { env: { NTFY_URL: undefined } }, () => {
  let fetchStub: Stub;

  beforeEach(() => {
    fetchStub = stubFetch(() => new Response());
  });

  afterEach(() => {
    if (!fetchStub.restored) fetchStub.restore();
  });

  describe("sendNtfyError", () => {
    test("does nothing when NTFY_URL is not set", () => {
      sendNtfyError(ErrorCode.DB_CONNECTION);

      expect(fetchStub.calls.length).toBe(0);
    });

    test("sends POST to ntfy URL with error code as body", () => {
      Deno.env.set("NTFY_URL", "https://ntfy.sh/my-topic");

      sendNtfyError(ErrorCode.DB_CONNECTION);

      expect(fetchStub.calls.length).toBe(1);
      const [url, options] = fetchStub.calls[0]!.args as [string, RequestInit];
      expect(url).toBe("https://ntfy.sh/my-topic");
      expect(options.method).toBe("POST");
      expect(options.body).toBe("E_DB_CONNECTION");
    });

    test("includes domain in Title header", () => {
      Deno.env.set("NTFY_URL", "https://ntfy.sh/my-topic");

      sendNtfyError(ErrorCode.CAPACITY_EXCEEDED);

      const [, options] = fetchStub.calls[0]!.args as [string, RequestInit];
      const headers = options.headers as Record<string, string>;
      expect(headers.Title).toBe("localhost error");
    });

    test("includes warning tag in headers", () => {
      Deno.env.set("NTFY_URL", "https://ntfy.sh/my-topic");

      sendNtfyError(ErrorCode.STRIPE_SIGNATURE);

      const [, options] = fetchStub.calls[0]!.args as [string, RequestInit];
      const headers = options.headers as Record<string, string>;
      expect(headers.Tags).toBe("warning");
    });

    test("logs error locally when fetch fails", async () => {
      Deno.env.set("NTFY_URL", "https://ntfy.sh/my-topic");
      fetchStub.restore();
      using failedFetch = stubFetch(new Error("Network error"));
      const errorSpy = spy(console, "error");

      sendNtfyError(ErrorCode.WEBHOOK_SEND);

      // Wait for the rejected promise's .catch handler to run
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(failedFetch.calls.length).toBe(1);
      expect(errorSpy.calls.length).toBe(1);
      expect(errorSpy.calls[0]!.args[0]).toContain("[Error] E_CDN_REQUEST");
      expect(errorSpy.calls[0]!.args[0]).toContain("ntfy send failed");
      errorSpy.restore();
    });
  });
});
