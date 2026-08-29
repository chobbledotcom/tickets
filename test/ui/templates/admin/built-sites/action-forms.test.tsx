import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { signCsrfToken } from "#shared/csrf.ts";
import {
  ConfirmActionButton,
  SiteActionForm,
  TranslatedSubmitButton,
} from "#templates/admin/built-sites/action-forms.tsx";
import { setupTestEncryptionKey, withEnv } from "#test-utils/env.ts";

describe("built site action forms", () => {
  beforeAll(async () => {
    setupTestEncryptionKey();
    await signCsrfToken();
  });

  test("posts to this site's own action path, carrying a CSRF token", () => {
    const html = String(
      SiteActionForm({
        action: "bump-deadline",
        children: "the fields",
        siteId: 42,
      }),
    );

    expect(html).toContain('action="/admin/built-sites/42/bump-deadline"');
    expect(html).toContain('method="POST"');
    expect(html).toContain('name="csrf_token"');
    expect(html).toContain("the fields");
  });

  test("renders nothing at all in read-only mode", () => {
    using _env = withEnv({ READ_ONLY_FROM: "2020-01-01T00:00:00.000Z" });

    const html = String(
      SiteActionForm({
        action: "bump-deadline",
        children: "the fields",
        siteId: 42,
      }),
    );

    expect(html).toBe("");
  });

  test("labels a submit button with its translated copy and icon", () => {
    const html = String(
      TranslatedSubmitButton({
        icon: "save",
        labelKey: "built_sites.rotate_token",
      }),
    );

    expect(html).toContain("<span>Rotate token</span>");
    expect(html).toContain("/icons.svg#save");
    expect(html).toContain('type="submit"');
  });

  test("asks the operator to confirm before posting its action", () => {
    const html = String(
      ConfirmActionButton({
        action: "rotate-renewal-token",
        confirmKey: "built_sites.rotate_token_confirm",
        icon: "rotate-ccw",
        labelKey: "built_sites.rotate_token",
        siteId: 7,
      }),
    );

    expect(html).toContain(
      'action="/admin/built-sites/7/rotate-renewal-token"',
    );
    expect(html).toContain(
      "return confirm('The old URL will stop working. Continue?')",
    );
    expect(html).toContain("<span>Rotate token</span>");
    expect(html).toContain("/icons.svg#rotate-ccw");
  });

  test("hides the confirm button in read-only mode too", () => {
    using _env = withEnv({ READ_ONLY_FROM: "2020-01-01T00:00:00.000Z" });

    expect(
      String(
        ConfirmActionButton({
          action: "rotate-renewal-token",
          confirmKey: "built_sites.rotate_token_confirm",
          icon: "rotate-ccw",
          labelKey: "built_sites.rotate_token",
          siteId: 7,
        }),
      ),
    ).toBe("");
  });
});
