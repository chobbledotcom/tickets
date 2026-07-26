import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { defineLoopbackServer } from "#scripts/specs/evidence/server.ts";

describe("Cucumber evidence loopback server", () => {
  test("serves requests on an ephemeral local TCP port and closes", async () => {
    const startServer = defineLoopbackServer(
      (request) => new Response(new URL(request.url).pathname),
    );
    const server = startServer();
    try {
      const url = new URL(server.baseUrl);
      expect(url.hostname).toBe("127.0.0.1");
      expect(Number(url.port)).toBeGreaterThan(0);
      expect(await (await fetch(`${server.baseUrl}/ready`)).text()).toBe(
        "/ready",
      );
    } finally {
      await server.close();
    }
    await expect(fetch(`${server.baseUrl}/ready`)).rejects.toThrow();
  });
});
