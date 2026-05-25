import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  describeWithEnv,
  followRedirectWithFlash,
  testRequiresAuth,
} from "#test-utils";

describeWithEnv("test-utils/assertions", { db: true }, () => {
  testRequiresAuth("/admin/settings");

  testRequiresAuth("/admin/groups", {
    body: { name: "test" },
    method: "POST",
  });

  testRequiresAuth("/admin/event", {
    body: { max_attendees: "10", name: "test" },
    multipart: true,
  });

  testRequiresAuth("/admin/backup", {
    setup: async () => {
      const { setTestEnv } = await import("#test-utils");
      setTestEnv({ BUNNY_API_KEY: "test" });
    },
  });

  test("followRedirectWithFlash works when response has no flash cookies", async () => {
    const response = new Response(null, {
      headers: { location: "/admin" },
      status: 302,
    });
    const result = await followRedirectWithFlash(response, (request) => {
      return Promise.resolve(new Response(request.url));
    });
    expect(await result.text()).toBe("http://localhost/admin");
  });
});
