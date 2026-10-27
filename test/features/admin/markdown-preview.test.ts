/* jscpd:ignore-start -- imports */
import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { signCsrfToken } from "#shared/csrf.ts";
import { makeImage } from "#test-utils/admin-images.ts";
import { expectAltTextPreview } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { mockFormRequest } from "#test-utils/mocks.ts";
import { createTestEditorSession } from "#test-utils/session.ts";

/* jscpd:ignore-end */

describeWithEnv("the admin markdown preview", { db: true }, () => {
  test("resolves an img#id reference to the image's uid URL", async () => {
    const image = await makeImage("Hero");
    const editor = await createTestEditorSession();
    const response = await handleRequest(
      mockFormRequest(
        "/admin/markdown-preview",
        {
          content: `![Hero](img#${image.id})`,
          csrf_token: await signCsrfToken(),
        },
        editor.cookie,
      ),
    );
    expect(response.status).toBe(200);
    const body = await response.text();
    assertStringIncludes(body, `src="/image/${image.filename}"`);
    assertStringIncludes(body, 'alt="Hero"');
    assert(!body.includes("/image/id/"));
  });

  test("leaves an unknown img#id reference to its alt text", async () => {
    const editor = await createTestEditorSession({
      username: "previeweditor2",
    });
    const response = await handleRequest(
      mockFormRequest(
        "/admin/markdown-preview",
        {
          content: "![Ghost](img#424242)",
          csrf_token: await signCsrfToken(),
        },
        editor.cookie,
      ),
    );
    await expectAltTextPreview(response, "Ghost");
  });
});
