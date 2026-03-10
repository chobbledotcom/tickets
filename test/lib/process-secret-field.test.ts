import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { MASK_SENTINEL } from "#lib/db/settings.ts";
import { processSecretField } from "#routes/admin/settings.ts";

describe("processSecretField", () => {
  const makeForm = (fields: Record<string, string>) =>
    new URLSearchParams(fields);

  test("returns 'unchanged' when value is the mask sentinel", () => {
    const form = makeForm({ api_key: MASK_SENTINEL });
    const result = processSecretField(form, "api_key");
    expect(result).toEqual({ action: "unchanged" });
  });

  test("returns 'cleared' when value is empty", () => {
    const form = makeForm({ api_key: "" });
    const result = processSecretField(form, "api_key");
    expect(result).toEqual({ action: "cleared" });
  });

  test("returns 'cleared' when value is whitespace-only", () => {
    const form = makeForm({ api_key: "   " });
    const result = processSecretField(form, "api_key");
    expect(result).toEqual({ action: "cleared" });
  });

  test("returns 'cleared' when field is missing from form", () => {
    const form = makeForm({});
    const result = processSecretField(form, "api_key");
    expect(result).toEqual({ action: "cleared" });
  });

  test("returns 'provided' with trimmed value for non-empty input", () => {
    const form = makeForm({ api_key: "sk_test_123" });
    const result = processSecretField(form, "api_key");
    expect(result).toEqual({ action: "provided", value: "sk_test_123" });
  });

  test("trims whitespace from provided values", () => {
    const form = makeForm({ api_key: "  sk_test_456  " });
    const result = processSecretField(form, "api_key");
    expect(result).toEqual({ action: "provided", value: "sk_test_456" });
  });

  test("sentinel check takes priority over provided value", () => {
    // Sentinel is a specific string; even if it looks like a value, it should be "unchanged"
    const form = makeForm({ api_key: MASK_SENTINEL });
    const result = processSecretField(form, "api_key");
    expect(result.action).toBe("unchanged");
  });
});
