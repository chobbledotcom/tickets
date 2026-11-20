import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { describeWithEnv } from "#test-utils/db.ts";
import { buildCreateListingForm } from "#test-utils/db-helpers/listing-forms.ts";
import { testListingInput } from "#test-utils/factories.ts";

describeWithEnv("buildCreateListingForm", { db: true }, () => {
  test("refuses a value in a box the writer's page hides", () => {
    const input = testListingInput({
      name: "Hooked",
      webhookUrl: "https://example.com/hook",
    });
    expect(() => buildCreateListingForm(input, "editor")).toThrow(
      "The listing page hides webhookUrl. Turn its feature on first.",
    );
  });
});
