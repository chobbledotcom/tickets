import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { createDesktopHandler } from "#src/desktop-handler.ts";

const request = (path = "/", method = "GET"): Request =>
  new Request(`http://localhost${path}`, { method });

describe("desktop request handler", () => {
  test("opens setup before the site is configured", async () => {
    const paths: string[] = [];
    const handler = createDesktopHandler((incoming) => {
      paths.push(new URL(incoming.url).pathname);
      return Promise.resolve(new Response("Setup"));
    });

    const response = await handler(request());

    expect(paths).toEqual(["/setup/"]);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/setup/");
  });

  test("opens login after setup is complete", async () => {
    const handler = createDesktopHandler(() =>
      Promise.resolve(
        new Response(null, { headers: { location: "/" }, status: 302 }),
      ),
    );

    const response = await handler(request());

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/admin/login");
  });

  test("passes setup failures through", async () => {
    const handler = createDesktopHandler(() =>
      Promise.resolve(
        new Response("Unavailable", {
          headers: { location: "/" },
          status: 503,
        }),
      ),
    );

    const response = await handler(request());

    expect(response.status).toBe(503);
    expect(await response.text()).toBe("Unavailable");
  });

  test("passes other paths through unchanged", async () => {
    const paths: string[] = [];
    const handler = createDesktopHandler((incoming) => {
      paths.push(new URL(incoming.url).pathname);
      return Promise.resolve(new Response("Login"));
    });

    const response = await handler(request("/admin/login"));

    expect(paths).toEqual(["/admin/login"]);
    expect(await response.text()).toBe("Login");
  });

  test("passes root form submissions through unchanged", async () => {
    const methods: string[] = [];
    const handler = createDesktopHandler((incoming) => {
      methods.push(incoming.method);
      return Promise.resolve(new Response(null, { status: 204 }));
    });

    const response = await handler(request("/", "POST"));

    expect(methods).toEqual(["POST"]);
    expect(response.status).toBe(204);
  });
});
