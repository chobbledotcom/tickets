import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  WritableDangerLink,
  WritableOnly,
} from "#templates/admin/writable-only.tsx";
import { withEnv } from "#test-utils/env.ts";

test("renders writable danger links with their destructive styling", () => {
  using _env = withEnv({ READ_ONLY_FROM: undefined });
  const html = String(
    <WritableDangerLink href="/delete">Delete</WritableDangerLink>,
  );
  expect(html).toBe('<p><a class="danger" href="/delete">Delete</a></p>');
});

test("WritableOnly renders its children in writable mode", () => {
  using _env = withEnv({ READ_ONLY_FROM: undefined });
  const html = String(
    <WritableOnly>
      <span>visible</span>
    </WritableOnly>,
  );
  expect(html).toBe("<span>visible</span>");
});

// Regression: WritableOnly previously returned `null` in read-only mode, and
// the JSX factory wraps a component's return value as `new SafeHtml(result)`.
// `new SafeHtml(null).toString()` is the literal text "null", so writable-only
// controls rendered the word "null" on read-only pages. It must return an
// empty SafeHtml so the controls truly disappear.
test("WritableOnly renders nothing (not literal 'null') in read-only mode", () => {
  using _env = withEnv({ READ_ONLY_FROM: "2020-01-01T00:00:00.000Z" });
  const html = String(
    <WritableOnly>
      <span>hidden</span>
    </WritableOnly>,
  );
  expect(html).toBe("");
  expect(html).not.toContain("null");
});

// Regression (same root cause): WritableDangerLink wraps content in
// <WritableOnly>, so its read-only output must be empty too.
test("WritableDangerLink renders nothing in read-only mode", () => {
  using _env = withEnv({ READ_ONLY_FROM: "2020-01-01T00:00:00.000Z" });
  const html = String(
    <WritableDangerLink href="/delete">Delete</WritableDangerLink>,
  );
  expect(html).toBe("");
  expect(html).not.toContain("null");
});
