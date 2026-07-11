import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { WritableDangerLink } from "#templates/admin/writable-only.tsx";
import { setTestEnv } from "#test-utils/env.ts";

test("renders writable danger links with their destructive styling", () => {
  const restore = setTestEnv({ READ_ONLY_FROM: undefined });
  try {
    const html = String(
      <WritableDangerLink href="/delete">Delete</WritableDangerLink>,
    );
    expect(html).toBe('<p><a class="danger" href="/delete">Delete</a></p>');
  } finally {
    restore();
  }
});
