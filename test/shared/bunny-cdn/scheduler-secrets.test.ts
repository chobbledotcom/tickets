import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { bunnyHostingProvider } from "#shared/bunny-cdn.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import { TEST_SCHEDULED_NEXT_KEY } from "#test-utils/scheduled.ts";

const nextSecretListResponse = (): Response =>
  new Response(
    JSON.stringify({
      Secrets: [
        {
          Id: 8,
          LastModified: "2026-01-01",
          Name: "SCHEDULED_TASK_KEY_NEXT",
        },
      ],
    }),
  );

describeWithEnv(
  "Bunny scheduler secret promotion",
  { env: { BUNNY_API_KEY: "test-key" } },
  () => {
    test("sets primary, removes next, then publishes the staged values", async () => {
      using fetchStub = stubFetch(
        nextSecretListResponse(),
        new Response(null, { status: 204 }),
        new Response(null, { status: 204 }),
        new Response(null, { status: 204 }),
      );

      const result = await bunnyHostingProvider.promoteSecrets(
        "42",
        ["SCHEDULED_TASK_KEY", TEST_SCHEDULED_NEXT_KEY],
        "SCHEDULED_TASK_KEY_NEXT",
      );

      expect(result.ok).toBe(true);
      expect(fetchStub.calls.map(({ args }) => String(args[0]))).toEqual([
        "https://api.bunny.net/compute/script/42/secrets",
        "https://api.bunny.net/compute/script/42/secrets",
        "https://api.bunny.net/compute/script/42/secrets/8",
        "https://api.bunny.net/compute/script/42/publish",
      ]);
      expect(
        fetchStub.calls.map(({ args }) => (args[1] as RequestInit)?.method),
      ).toEqual([undefined, "PUT", "DELETE", "POST"]);
    });

    test("fails closed when the verified next slot has disappeared", async () => {
      using _fetch = stubFetch(new Response(JSON.stringify({ Secrets: [] })));
      expect(
        await bunnyHostingProvider.promoteSecrets(
          "42",
          ["SCHEDULED_TASK_KEY", TEST_SCHEDULED_NEXT_KEY],
          "SCHEDULED_TASK_KEY_NEXT",
        ),
      ).toEqual({
        error: "Missing secret SCHEDULED_TASK_KEY_NEXT",
        ok: false,
      });
    });

    test("stops when current secrets cannot be listed", async () => {
      using _fetch = stubFetch(new Response("failed", { status: 500 }));
      expect(
        await bunnyHostingProvider.promoteSecrets(
          "42",
          ["SCHEDULED_TASK_KEY", TEST_SCHEDULED_NEXT_KEY],
          "SCHEDULED_TASK_KEY_NEXT",
        ),
      ).toEqual({ error: "List secrets failed (500): failed", ok: false });
    });

    test("keeps next when primary cannot be staged", async () => {
      using _fetch = stubFetch(
        nextSecretListResponse(),
        new Response("failed", { status: 500 }),
      );
      expect(
        (
          await bunnyHostingProvider.promoteSecrets(
            "42",
            ["SCHEDULED_TASK_KEY", TEST_SCHEDULED_NEXT_KEY],
            "SCHEDULED_TASK_KEY_NEXT",
          )
        ).ok,
      ).toBe(false);
    });

    test("does not publish when next cannot be removed", async () => {
      using fetchStub = stubFetch(
        nextSecretListResponse(),
        new Response(null, { status: 204 }),
        new Response("failed", { status: 500 }),
      );
      expect(
        (
          await bunnyHostingProvider.promoteSecrets(
            "42",
            ["SCHEDULED_TASK_KEY", TEST_SCHEDULED_NEXT_KEY],
            "SCHEDULED_TASK_KEY_NEXT",
          )
        ).ok,
      ).toBe(false);
      expect(fetchStub.calls).toHaveLength(3);
    });
  },
);
