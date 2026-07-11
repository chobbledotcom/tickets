import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { bufferRequestBody } from "#routes/request-body.ts";

describe("bufferRequestBody", () => {
  test("reads a POST body up front into an independent in-memory request", async () => {
    const original = new Request("https://example.com/calculate/abc", {
      body: "quantity_1=2&csrf_token=tok",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
    });

    const buffered = await bufferRequestBody(original);

    // The body was consumed eagerly — this is what insulates the later form
    // parse from the edge runtime tearing the body resource down mid-request.
    expect(original.bodyUsed).toBe(true);
    // A fresh request, not the original, backed by the buffered bytes.
    expect(buffered).not.toBe(original);
    expect(buffered.method).toBe("POST");
    expect(buffered.headers.get("content-type")).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(await buffered.text()).toBe("quantity_1=2&csrf_token=tok");
  });

  test("preserves the URL so downstream base-URL / slug parsing is unchanged", async () => {
    const original = new Request("https://example.com/calculate/a+b?x=1", {
      body: "k=v",
      method: "POST",
    });

    const buffered = await bufferRequestBody(original);

    expect(buffered.url).toBe("https://example.com/calculate/a+b?x=1");
  });

  test("passes a GET request through untouched (no body to read)", async () => {
    const get = new Request("https://example.com/ticket/abc", {
      method: "GET",
    });

    const result = await bufferRequestBody(get);

    // Returned as-is: reconstructing a GET with a body would throw, and a GET
    // page render must keep reading the same request it was handed.
    expect(result).toBe(get);
    expect(result.bodyUsed).toBe(false);
  });

  test("passes a HEAD request through untouched", async () => {
    const head = new Request("https://example.com/ticket/abc", {
      method: "HEAD",
    });

    const result = await bufferRequestBody(head);

    expect(result).toBe(head);
    expect(result.bodyUsed).toBe(false);
  });
});
