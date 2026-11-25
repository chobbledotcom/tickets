import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  isJsonApiPath,
  isValidContentType,
  lowerContentType,
  shouldBufferRequestBody,
} from "#routes/content-type-rules.ts";

const requestWithType = (method: string, contentType?: string): Request =>
  new Request("http://localhost/test", {
    ...(contentType === undefined
      ? {}
      : { headers: { "content-type": contentType } }),
    method,
  });

describe("isJsonApiPath", () => {
  for (const path of [
    "/admin/listing/12/scan",
    "/admin/listing/1/scan",
    "/admin/groups/3/scan-cache",
    "/api/listings",
    "/v1/devices/one",
  ]) {
    test(`${path} is a JSON API path`, () => {
      expect(isJsonApiPath(path)).toBe(true);
    });
  }

  for (const path of [
    "/admin/listing/x/scan",
    "/admin/listing/abc/scan",
    "/admin/listing/123/edit",
    "/admin/listing//scan",
    "/payment/webhook",
    "/apis/listings",
    "/v10/devices/one",
  ]) {
    test(`${path} is not a JSON API path`, () => {
      expect(isJsonApiPath(path)).toBe(false);
    });
  }
});

describe("isValidContentType", () => {
  test("normalizes a missing content type to an empty string", () => {
    expect(lowerContentType(requestWithType("POST"))).toBe("");
  });

  test("non-POST requests need no content type", () => {
    expect(isValidContentType(requestWithType("PATCH"), "/admin/login")).toBe(
      true,
    );
  });

  test("normal middleware does not exempt the specialized scheduled route", () => {
    expect(isValidContentType(requestWithType("POST"), "/scheduled")).toBe(
      false,
    );
  });

  test("/instance/site-credentials accepts a bodyless POST", () => {
    expect(
      isValidContentType(requestWithType("POST"), "/instance/site-credentials"),
    ).toBe(true);
  });

  for (const path of [
    "/payment/webhook",
    "/sms/webhook",
    "/admin/listing/12/scan",
    "/api/listings",
    "/v1/devices/one",
  ]) {
    test(`${path} accepts JSON case-insensitively`, () => {
      expect(
        isValidContentType(
          requestWithType("POST", "Application/JSON; charset=utf-8"),
          path,
        ),
      ).toBe(true);
    });
  }

  test("JSON endpoints reject another content type", () => {
    expect(
      isValidContentType(
        requestWithType("POST", "text/plain"),
        "/payment/webhook",
      ),
    ).toBe(false);
  });

  for (const path of ["/payment/webhooks", "/sms/webhooks"]) {
    test(`${path} is not a webhook, so it rejects JSON`, () => {
      expect(
        isValidContentType(requestWithType("POST", "application/json"), path),
      ).toBe(false);
    });
  }

  test("ordinary forms accept URL-encoded content", () => {
    expect(
      isValidContentType(
        requestWithType("POST", "application/x-www-form-urlencoded"),
        "/admin/login",
      ),
    ).toBe(true);
  });

  test("ordinary forms accept multipart content", () => {
    expect(
      isValidContentType(
        requestWithType("POST", "multipart/form-data; boundary=test"),
        "/admin/login",
      ),
    ).toBe(true);
  });

  test("ordinary forms reject missing content", () => {
    expect(isValidContentType(requestWithType("POST"), "/admin/login")).toBe(
      false,
    );
  });
});

describe("shouldBufferRequestBody", () => {
  test("buffers each body type read by a POST handler", () => {
    for (const contentType of [
      "application/x-www-form-urlencoded; charset=utf-8",
      "multipart/form-data; boundary=test",
      "Application/JSON; charset=utf-8",
    ]) {
      expect(
        shouldBufferRequestBody(requestWithType("POST", contentType)),
      ).toBe(true);
    }
  });

  test("does not buffer bodyless, unused, or non-POST bodies", () => {
    expect(shouldBufferRequestBody(requestWithType("POST"))).toBe(false);
    expect(shouldBufferRequestBody(requestWithType("POST", "text/plain"))).toBe(
      false,
    );
    expect(
      shouldBufferRequestBody(requestWithType("PUT", "application/json")),
    ).toBe(false);
  });
});
