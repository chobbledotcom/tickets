/** Fractional counts: the listing form and the listing JSON API refuse the
 *  same submitted value. The shared declaration is the catalog field's kind —
 *  the form's installed validator and the API's kind check read the same
 *  kinds, so one surface cannot accept what the other refuses. */

// jscpd:ignore-start
import { expect } from "@std/expect";
import { beforeAll, it as test } from "@std/testing/bdd";
import { ensureMessageGroups } from "#i18n";
import {
  bodyToCreateInput,
  type CreateListingBody,
} from "#routes/admin/api-listing-body.ts";
import { buildCreateListingResource } from "#routes/admin/listings-form.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  type TestFormValues,
  testFormParams,
} from "#test-utils/form-values.ts";

// jscpd:ignore-end

const listingForm = (extra: TestFormValues = {}) =>
  testFormParams({
    max_attendees: "50",
    max_quantity: "5",
    name: "Parsed listing",
    ...extra,
  });

/** One fractional value submitted to both surfaces, with each surface's own
 *  refusal message. */
const FRACTIONAL_CASES: readonly {
  apiBody: CreateListingBody;
  apiError: string;
  formError: string;
  formExtra: TestFormValues;
}[] = [
  {
    apiBody: { max_attendees: 10, max_quantity: 1.5, name: "Test" },
    apiError: "max_quantity has an invalid value",
    formError: "Max tickets per purchase must be a whole number",
    formExtra: { max_quantity: "1.5" },
  },
  {
    apiBody: { max_attendees: 10, minimum_days_before: 1.5, name: "Test" },
    apiError: "minimum_days_before has an invalid value",
    formError:
      "Minimum days notice (for daily listings) must be a whole number",
    formExtra: { minimum_days_before: "1.5" },
  },
];

describeWithEnv("listing whole-number parity", { db: true }, () => {
  beforeAll(() => ensureMessageGroups(["listings-table", "validation"]));

  test("the form and the JSON API refuse the same fractional value", async () => {
    for (const {
      apiBody,
      apiError,
      formError,
      formExtra,
    } of FRACTIONAL_CASES) {
      const form = listingForm(formExtra);
      const formResult = await buildCreateListingResource(form).create(form);
      expect(formResult.ok).toBe(false);
      if (!formResult.ok) expect(formResult.error).toBe(formError);

      const apiResult = await bodyToCreateInput(apiBody);
      expect(apiResult.ok).toBe(false);
      if (!apiResult.ok) expect(apiResult.error).toBe(apiError);
    }
  });
});
