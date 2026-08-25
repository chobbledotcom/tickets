import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  apiErrorMessage,
  fetchText,
  jsonHeaders,
  parseApiError,
} from "#shared/fetch.ts";
import {
  getSubrequestUsage,
  runWithSubrequestBudget,
} from "#shared/subrequest-budget.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";

test("adds the JSON content type to authentication headers", () => {
  expect(jsonHeaders({ Authorization: "Bearer token" })).toEqual({
    Authorization: "Bearer token",
    "Content-Type": "application/json",
  });
});

describe("fetchText", () => {
  test("returns status, ok, text, and headers from a successful response", async () => {
    using _fetch = stubFetch(
      new Response('{"id":1}', {
        headers: { "Content-Type": "application/json" },
        status: 200,
      }),
    );

    const result = await fetchText("https://example.com/api");

    expect(result.status).toBe(200);
    expect(result.ok).toBe(true);
    expect(result.text).toBe('{"id":1}');
    expect(result.headers.get("Content-Type")).toBe("application/json");
  });

  test("returns ok false for error status codes", async () => {
    using _fetch = stubFetch(new Response("Not Found", { status: 404 }));

    const result = await fetchText("https://example.com/missing");

    expect(result.status).toBe(404);
    expect(result.ok).toBe(false);
    expect(result.text).toBe("Not Found");
  });

  test("handles empty response body", async () => {
    using _fetch = stubFetch(new Response(null, { status: 204 }));

    const result = await fetchText("https://example.com/empty", undefined, 0);

    expect(result.status).toBe(204);
    expect(result.ok).toBe(true);
    expect(result.text).toBe("");
  });

  test("accepts a response body at the byte limit", async () => {
    using _fetch = stubFetch(new Response("four"));

    const result = await fetchText("https://example.com/limited", undefined, 4);

    expect(result.text).toBe("four");
  });

  test("cancels a response body above the byte limit", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel: () => {
        cancelled = true;
      },
      start: (controller) => {
        controller.enqueue(new TextEncoder().encode("four"));
        controller.enqueue(new TextEncoder().encode("!"));
      },
    });
    using _fetch = stubFetch(new Response(body));

    await expect(
      fetchText("https://example.com/too-large", undefined, 4),
    ).rejects.toThrow("Response body exceeds 4 bytes");
    expect(cancelled).toBe(true);
  });

  test("forwards request init options", async () => {
    using fetchStub = stubFetch(new Response("ok"));

    await fetchText("https://example.com/post", {
      body: "payload",
      headers: { Authorization: "Bearer token" },
      method: "POST",
    });

    expect(fetchStub.calls.length).toBe(1);
    const [url, init] = fetchStub.calls[0]!.args;
    expect(url).toBe("https://example.com/post");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer token",
    );
    expect(init?.body).toBe("payload");
  });

  test("propagates fetch errors", async () => {
    using _fetch = stubFetch(new TypeError("Network error"));

    await expect(fetchText("https://example.com/fail")).rejects.toThrow(
      "Network error",
    );
  });

  test("counts one external subrequest", async () => {
    using _fetch = stubFetch(new Response("ok"));

    await runWithSubrequestBudget(async () => {
      await fetchText("https://example.com/api");
      expect(getSubrequestUsage()).toEqual({
        database: 0,
        external: 1,
        total: 1,
      });
    });
  });
});

describe("parseApiError", () => {
  test("extracts the 'message' field and reports ok:false", () => {
    const result = parseApiError(
      { status: 400, text: '{"message":"Bad input"}' },
      "Turso",
    );
    expect(result).toEqual({
      error: "Turso failed (400): Bad input",
      ok: false,
    });
  });

  test("falls back to the 'error' field when 'message' is absent", () => {
    const result = parseApiError(
      { status: 500, text: '{"error":"boom"}' },
      "Deploy",
    );
    expect(result).toEqual({ error: "Deploy failed (500): boom", ok: false });
  });

  test("prefers 'message' over 'error' (first matching key wins)", () => {
    const result = parseApiError(
      { status: 422, text: '{"message":"primary","error":"secondary"}' },
      "Bunny",
    );
    expect(result.error).toBe("Bunny failed (422): primary");
  });

  test("honours a custom key list", () => {
    const result = parseApiError(
      { status: 403, text: '{"detail":"nope","message":"ignored"}' },
      "Custom",
      ["detail"],
    );
    expect(result.error).toBe("Custom failed (403): nope");
  });

  test("uses the raw text when the body is not JSON", () => {
    const result = parseApiError(
      { status: 502, text: "Bad Gateway" },
      "Upstream",
    );
    expect(result.error).toBe("Upstream failed (502): Bad Gateway");
  });

  test("uses the raw text when JSON has no matching key", () => {
    const result = parseApiError(
      { status: 400, text: '{"unexpected":"shape"}' },
      "Api",
    );
    expect(result.error).toBe('Api failed (400): {"unexpected":"shape"}');
  });
});

describe("apiErrorMessage", () => {
  test("joins the messages of an errors array (SendGrid's shape)", () => {
    expect(
      apiErrorMessage(
        '{"errors":[{"message":"first","field":"from"},{"message":"second"}]}',
        ["message", "errors"],
      ),
    ).toBe("first; second");
  });

  test("accepts plain-string entries in an error array", () => {
    expect(apiErrorMessage('{"errors":["bad key"]}', ["errors"])).toBe(
      "bad key",
    );
  });

  test("skips array entries that carry no message", () => {
    expect(
      apiErrorMessage('{"errors":[null,{"code":9},{"message":"kept"}]}', [
        "errors",
      ]),
    ).toBe("kept");
  });

  test("returns the raw text when no array entry carries a message", () => {
    expect(apiErrorMessage('{"errors":[{"code":9}]}', ["errors"])).toBe(
      '{"errors":[{"code":9}]}',
    );
  });

  test("skips an empty-string message and tries the next key", () => {
    expect(apiErrorMessage('{"message":"","error":"boom"}')).toBe("boom");
  });

  test("ignores a non-string message value", () => {
    expect(apiErrorMessage('{"message":{"nested":true}}')).toBe(
      '{"message":{"nested":true}}',
    );
  });

  test("returns the raw text for a non-object JSON body", () => {
    expect(apiErrorMessage("null")).toBe("null");
  });
});
