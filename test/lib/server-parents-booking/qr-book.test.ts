import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { buildQrBookPayload, signQrBookToken } from "#shared/qr-token.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { makeParent } from "#test-utils/parents.ts";

describeWithEnv(
  "server > parents booking — QR book",
  { db: true, triggers: true },
  () => {
    test("a signed QR for a child is rejected", async () => {
      const { child } = await makeParent();
      const { handleRequest } = await import("#routes");
      const token = await signQrBookToken(
        child.slug,
        buildQrBookPayload({ name: "Ada" }),
      );
      const res = await handleRequest(
        new Request(
          `http://localhost/ticket/${child.slug}/qr-book?t=${encodeURIComponent(
            token,
          )}`,
          { headers: { host: "localhost" } },
        ),
      );
      expect(res.status).toBe(404);
    });
  },
);
