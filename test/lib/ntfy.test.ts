import { afterEach, beforeEach, describe, expect, spyOn, test } from "#test-compat";
import { sendNtfyError } from "#lib/ntfy.ts";
import { ErrorCode } from "#lib/logger.ts";

describe("ntfy", () => {
  // deno-lint-ignore no-explicit-any
  let fetchSpy: any;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response());
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    globalThis.fetch = originalFetch;
    Deno.env.delete("NTFY_URL");
  });

  describe("sendNtfyError", () => {
    test("does nothing when NTFY_URL is not set", () => {
      sendNtfyError(ErrorCode.DB_CONNECTION);

      expect(fetchSpy).not.toHaveBeenCalled();
    });

    test("sends POST to ntfy URL with error code as body", () => {
      Deno.env.set("NTFY_URL", "https://ntfy.sh/my-topic");

      sendNtfyError(ErrorCode.DB_CONNECTION);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://ntfy.sh/my-topic");
      expect(options.method).toBe("POST");
      expect(options.body).toBe("E_DB_CONNECTION");
    });

    test("includes domain in Title header", () => {
      Deno.env.set("NTFY_URL", "https://ntfy.sh/my-topic");

      sendNtfyError(ErrorCode.CAPACITY_EXCEEDED);

      const [, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const headers = options.headers as Record<string, string>;
      expect(headers["Title"]).toBe("localhost error");
    });

    test("includes warning tag in headers", () => {
      Deno.env.set("NTFY_URL", "https://ntfy.sh/my-topic");

      sendNtfyError(ErrorCode.STRIPE_SIGNATURE);

      const [, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const headers = options.headers as Record<string, string>;
      expect(headers["Tags"]).toBe("warning");
    });

    test("silently ignores fetch errors", () => {
      Deno.env.set("NTFY_URL", "https://ntfy.sh/my-topic");
      fetchSpy.mockRejectedValue(new Error("Network error"));

      // Should not throw
      sendNtfyError(ErrorCode.WEBHOOK_SEND);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });
});
