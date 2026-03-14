import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { spy, stub } from "@std/testing/mock";
import { ErrorCode } from "#lib/logger.ts";
import { sendNtfyError } from "#lib/ntfy.ts";

describe("ntfy", () => {
  let fetchStub: ReturnType<typeof stub<typeof globalThis, "fetch">>;

  beforeEach(() => {
    fetchStub = stub(globalThis, "fetch", () =>
      Promise.resolve(new Response()),
    );
  });

  afterEach(() => {
    fetchStub.restore();
    Deno.env.delete("NTFY_URL");
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
      const [url, options] = fetchStub.calls[0]?.args as [string, RequestInit];
      expect(url).toBe("https://ntfy.sh/my-topic");
      expect(options.method).toBe("POST");
      expect(options.body).toBe("E_DB_CONNECTION");
    });

    test("includes domain in Title header", () => {
      Deno.env.set("NTFY_URL", "https://ntfy.sh/my-topic");

      sendNtfyError(ErrorCode.CAPACITY_EXCEEDED);

      const [, options] = fetchStub.calls[0]?.args as [string, RequestInit];
      const headers = options.headers as Record<string, string>;
      expect(headers.Title).toBe("localhost error");
    });

    test("includes warning tag in headers", () => {
      Deno.env.set("NTFY_URL", "https://ntfy.sh/my-topic");

      sendNtfyError(ErrorCode.STRIPE_SIGNATURE);

      const [, options] = fetchStub.calls[0]?.args as [string, RequestInit];
      const headers = options.headers as Record<string, string>;
      expect(headers.Tags).toBe("warning");
    });

    test("logs error when fetch fails", async () => {
      Deno.env.set("NTFY_URL", "https://ntfy.sh/my-topic");
      fetchStub.restore();
      fetchStub = stub(globalThis, "fetch", () =>
        Promise.reject(new Error("Network error")),
      );
      const errorSpy = spy(console, "error");

      sendNtfyError(ErrorCode.WEBHOOK_SEND);

      // Wait for the rejected promise's .catch handler to run
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(fetchStub.calls.length).toBe(1);
      expect(errorSpy.calls[0]?.args).toEqual(["[Error] E_NTFY_SEND"]);
      errorSpy.restore();
    });
  });
});
