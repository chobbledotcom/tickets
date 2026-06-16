import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { clearFormStash } from "#shared/form-stash.ts";
import {
  adminFormPost,
  describeWithEnv,
  expectFlash,
  followRedirectWithFlash,
} from "#test-utils";

/**
 * End-to-end coverage of the POST → redirect → GET form re-fill: a failed admin
 * create redirects back to the form, and the warm-isolate stash restores the
 * fields the user already typed. The flash cookie still carries the message,
 * so a cold isolate degrades gracefully to message-only.
 */
describeWithEnv("form re-fill across an error redirect", { db: true }, () => {
  test("restores typed-in fields on the follow-up GET (warm isolate)", async () => {
    const { response, cookie } = await adminFormPost("/admin/groups", {
      description: "Remember this description",
      name: "",
    });
    // The submission fails validation and redirects with the error message.
    expectFlash(response, "Group Name is required", false);

    const followed = await followRedirectWithFlash(
      response,
      handleRequest,
      cookie,
    );
    const html = await followed.text();
    expect(followed.status).toBe(200);
    // The description the user already typed is restored from the stash.
    expect(html).toContain("Remember this description");
  });

  test("keeps the message but drops the re-fill on a cold isolate", async () => {
    const { response, cookie } = await adminFormPost("/admin/groups", {
      description: "This text would be lost",
      name: "",
    });
    // Simulate the follow-up GET landing on a different / recycled isolate.
    clearFormStash();

    const followed = await followRedirectWithFlash(
      response,
      handleRequest,
      cookie,
    );
    const html = await followed.text();
    expect(html).not.toContain("This text would be lost");
  });
});
