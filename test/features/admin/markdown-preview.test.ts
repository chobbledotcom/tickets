import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { imageUrlsFor } from "#db/images.ts";
import { handleRequest } from "#routes";
import { signCsrfToken } from "#shared/csrf.ts";
import { makeImage } from "#test-utils/admin-images.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { mockFormRequest } from "#test-utils/mocks.ts";
import { createTestEditorSession } from "#test-utils/session.ts";

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
    expect(body).toContain(`src="/image/${image.filename}"`);
    expect(body).toContain('alt="Hero"');
    expect(body).not.toContain("/image/id/");
    // The loader bounds its read by the referenced ids and answers the same
    // table the handler preloaded.
    const urls = await imageUrlsFor([`![Hero](img#${image.id})`]);
    expect(urls.get(image.id)).toBe(`/image/${image.filename}`);
    expect(await imageUrlsFor(["no references here"])).toEqual(new Map());
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
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('<img src="" alt="Ghost">');
  });
});
