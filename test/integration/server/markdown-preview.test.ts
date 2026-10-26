import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { signCsrfToken } from "#shared/csrf.ts";
import { makeImage } from "#test-utils/admin-images.ts";
import { expectAltTextPreview } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { mockFormRequest } from "#test-utils/mocks.ts";
import { testCookie } from "#test-utils/session.ts";

/** POST the preview endpoint's form with a signed CSRF token and the owner
 * session. */
const postPreview = async (content: string): Promise<Response> =>
  handleRequest(
    mockFormRequest(
      "/admin/markdown-preview",
      { content, csrf_token: await signCsrfToken() },
      await testCookie(),
    ),
  );

describeWithEnv("POST /admin/markdown-preview", { db: true }, () => {
  test("resolves an img#N reference in the buffer to the image's URL", async () => {
    const hero = await makeImage("Hero");

    const response = await postPreview(`![Hero](img#${hero.id})`);

    expect(response.status).toBe(200);
    assertStringIncludes(
      await response.text(),
      `<img src="/image/${hero.filename}" alt="Hero">`,
    );
  });

  test("renders an img#N reference the image table lacks as its alt text", async () => {
    const response = await postPreview("![Ghost](img#99999)");

    await expectAltTextPreview(response, "Ghost");
  });
});
