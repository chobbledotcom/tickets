import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { createUptimeKumaClient } from "#shared/uptime-kuma/client.ts";
import { FakeSocket } from "./support.test.ts";

type AuthenticationFields = {
  authMethod: string;
  bearer_token: string | null;
  headers: string | null;
};

const readAuthorization = async (
  authentication: AuthenticationFields,
): Promise<string | null> => {
  const socket = new FakeSocket();
  socket.reply("getMonitorList", () => {
    socket.emitEvent("monitorList", {
      "7": {
        accepted_statuscodes: ["200-299"],
        active: true,
        id: 7,
        interval: 60,
        method: "POST",
        name: "Authenticated monitor",
        parent: 3,
        type: "http",
        url: "https://child.example.test/scheduled",
        ...authentication,
      },
    });
    return { ok: true };
  });
  const [monitor] = await createUptimeKumaClient(socket).getMonitors();
  if (monitor === undefined) throw new Error("Kuma returned no monitor");
  return monitor.authorization;
};

describe("Uptime Kuma monitor authorization", () => {
  for (const scenario of [
    {
      authentication: {
        authMethod: "bearer",
        bearer_token: "site key",
        headers: null,
      },
      expected: "Bearer site key",
      name: "uses built-in bearer authentication",
    },
    {
      authentication: {
        authMethod: "bearer",
        bearer_token: "replaced key",
        headers: '{"authorization":"Bearer custom key"}',
      },
      expected: "Bearer custom key",
      name: "lets custom authorization override built-in bearer authentication",
    },
    {
      authentication: {
        authMethod: "bearer",
        bearer_token: "replaced key",
        headers: '{"Authorization":""}',
      },
      expected: "",
      name: "keeps an empty custom authorization override",
    },
    {
      authentication: {
        authMethod: "bearer",
        bearer_token: "site key",
        headers: '{"X-Trace":"on"}',
      },
      expected: "Bearer site key",
      name: "keeps built-in bearer authentication beside other custom headers",
    },
    {
      authentication: {
        authMethod: "bearer",
        bearer_token: "must not hide broken headers",
        headers: "not JSON",
      },
      expected: null,
      name: "does not hide malformed custom headers with built-in bearer authentication",
    },
    {
      authentication: {
        authMethod: "basic",
        bearer_token: "unused bearer token",
        headers: null,
      },
      expected: null,
      name: "ignores a bearer token when bearer authentication is not selected",
    },
  ] satisfies Array<{
    authentication: AuthenticationFields;
    expected: string | null;
    name: string;
  }>) {
    test(scenario.name, async () => {
      expect(await readAuthorization(scenario.authentication)).toBe(
        scenario.expected,
      );
    });
  }
});
