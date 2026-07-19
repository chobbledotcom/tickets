// test-groups: run-alone - this suite verifies isolate-lived wake throttling.
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  bufferRequestIfNeeded,
  ensureCustomCssResponse,
  isSetupPath,
  runOrganicMaintenanceWhenDue,
  shouldBufferRequestBody,
  shouldLogQueries,
  shouldPrefetchSettings,
  shouldRetryBusyRequest,
  trackingRedirectLocation,
} from "#routes/app/rules.ts";

const request = (method: string, contentType?: string): Request =>
  new Request("https://example.com/path", {
    ...(contentType ? { headers: { "content-type": contentType } } : {}),
    method,
  });

describe("request rules", () => {
  test("buffers each body type read by a POST handler", () => {
    for (const contentType of [
      "application/x-www-form-urlencoded; charset=utf-8",
      "multipart/form-data; boundary=test",
      "Application/JSON; charset=utf-8",
    ]) {
      expect(shouldBufferRequestBody(request("POST", contentType))).toBe(true);
    }
  });

  test("does not buffer bodyless, unused, or non-POST bodies", () => {
    expect(shouldBufferRequestBody(request("POST"))).toBe(false);
    expect(shouldBufferRequestBody(request("POST", "text/plain"))).toBe(false);
    expect(shouldBufferRequestBody(request("PUT", "application/json"))).toBe(
      false,
    );
  });

  test("buffers an eligible request body", async () => {
    const original = new Request("https://example.com/path", {
      body: "payload",
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    const buffered = await bufferRequestIfNeeded(original);

    expect(buffered).not.toBe(original);
    expect(await buffered.text()).toBe("payload");
  });

  test("keeps an ineligible request unchanged", async () => {
    const original = request("POST", "text/plain");
    expect(await bufferRequestIfNeeded(original)).toBe(original);
  });

  test("logs queries only for admin GET requests", () => {
    expect(shouldLogQueries("GET", "admin")).toBe(true);
    expect(shouldLogQueries("POST", "admin")).toBe(false);
    expect(shouldLogQueries("GET", "ticket")).toBe(false);
  });

  test("runs organic maintenance only after safe successful reads", async () => {
    const calls: string[] = [];
    const run = (name: string) => () => {
      calls.push(name);
    };
    await runOrganicMaintenanceWhenDue("GET", "/", 200, run("get"), 0);
    await runOrganicMaintenanceWhenDue(
      "HEAD",
      "/admin",
      204,
      run("head"),
      60_000,
    );
    await runOrganicMaintenanceWhenDue("POST", "/", 200, run("post"), 120_000);
    await runOrganicMaintenanceWhenDue("GET", "/", 199, run("early"), 120_000);
    await runOrganicMaintenanceWhenDue("GET", "/", 404, run("error"), 120_000);
    expect(calls).toEqual(["get", "head"]);
  });

  test("excludes checkout, payment, webhook, and setup paths", async () => {
    const calls: string[] = [];
    for (const path of [
      "/api/listing/book",
      "/calculate/listing",
      "/order",
      "/pay/token",
      "/payment/webhook",
      "/renew",
      "/sms/webhook",
      "/ticket/listing",
      "/setup",
    ]) {
      await runOrganicMaintenanceWhenDue(
        "GET",
        path,
        200,
        () => {
          calls.push(path);
        },
        120_000,
      );
    }
    expect(calls).toEqual([]);
  });

  test("throttles repeated organic wakes in one warm isolate", async () => {
    const calls: number[] = [];
    const run = (time: number) => () => {
      calls.push(time);
    };
    await runOrganicMaintenanceWhenDue("GET", "/", 200, run(120_000), 120_000);
    await runOrganicMaintenanceWhenDue("GET", "/", 200, run(179_999), 179_999);
    await runOrganicMaintenanceWhenDue("GET", "/", 200, run(180_000), 180_000);
    expect(calls).toEqual([120_000, 180_000]);
  });

  test("retries busy requests only when they are safe to repeat", () => {
    expect(shouldRetryBusyRequest("GET")).toBe(true);
    expect(shouldRetryBusyRequest("HEAD")).toBe(true);
    expect(shouldRetryBusyRequest("POST")).toBe(false);
  });

  test("recognizes only the setup path family", () => {
    expect(isSetupPath("/setup")).toBe(true);
    expect(isSetupPath("/setup/")).toBe(true);
    expect(isSetupPath("/setup/account")).toBe(true);
    expect(isSetupPath("/setups")).toBe(false);
    expect(isSetupPath("/")).toBe(false);
  });

  test("prefetches settings only outside setup", () => {
    expect(shouldPrefetchSettings("/")).toBe(true);
    expect(shouldPrefetchSettings("/setup")).toBe(false);
    expect(shouldPrefetchSettings("/setup/account")).toBe(false);
  });

  test("returns a clean location only for tracked GET requests", () => {
    const tracked = new URL(
      "https://example.com/ticket/one?keep=yes&utm_source=test",
    );
    expect(trackingRedirectLocation(tracked, "GET")).toBe(
      "/ticket/one?keep=yes",
    );
    expect(trackingRedirectLocation(tracked, "POST")).toBeNull();
    expect(
      trackingRedirectLocation(
        new URL("https://example.com/ticket/one"),
        "GET",
      ),
    ).toBeNull();
  });

  test("turns an HTML custom CSS fallback into an empty stylesheet", async () => {
    const response = ensureCustomCssResponse(
      "/custom.css",
      new Response("<h1>Error</h1>", {
        headers: { "content-type": "text/html" },
      }),
    );
    expect(response.headers.get("content-type")).toContain("text/css");
    expect(await response.text()).toBe("");
  });

  test("preserves valid CSS, redirects, and responses for other paths", () => {
    const css = new Response("body {}", {
      headers: { "content-type": "text/css" },
    });
    const redirect = new Response(null, { status: 301 });
    const html = new Response("page", {
      headers: { "content-type": "text/html" },
    });
    expect(ensureCustomCssResponse("/custom.css", css)).toBe(css);
    expect(ensureCustomCssResponse("/custom.css", redirect)).toBe(redirect);
    expect(ensureCustomCssResponse("/other", html)).toBe(html);
  });
});
