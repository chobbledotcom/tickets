import { it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { expectHtmlResponse } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { mockRequest } from "#test-utils/mocks.ts";

describeWithEnv("GET /payment/cancel", { db: true }, () => {
  test("returns a provider-not-configured error when no provider is set", async () => {
    const response = await handleRequest(
      mockRequest("/payment/cancel?session_id=cs_no_provider"),
    );
    await expectHtmlResponse(response, 400, "Payment provider not configured");
  });
});
