import { compile } from "@cucumber/gherkin";
import { IdGenerator, type Pickle } from "@cucumber/messages";
import type { EvidenceCaptureDeclaration } from "#scripts/specs/evidence/schema.ts";
import { parseGherkinSource } from "#scripts/specs/gherkin.ts";
import { validateSpecSources } from "#scripts/specs/profile.ts";
import { registry, source } from "#test/scripts/specs/profile-fixture.ts";

/** The capture two of these tests both declare: a page the story leaves
 * behind, the part of it to show, and nothing about how it looks. */
export const PAYMENT_RESULT_CAPTURE = {
  caseId: "payment.place-available",
  element: "#payment-result",
  id: "payment-result",
  presentation: "canonical",
  profiles: ["mobile"],
} as const satisfies EvidenceCaptureDeclaration;

/** The page that capture's story leaves behind. */
export const PAYMENT_RESULT_PAGE = "/admin/payments/42";

export const PLAIN_EVIDENCE_SCENARIO = {
  case: {
    id: "payment.place-available",
    name: "Payment is confirmed before the last place is taken",
  },
  rule: {
    description: "The confirmed payment creates the promised booking.",
    id: "payments.available-place-is-booked",
    name: "A paid customer receives a place while one remains",
  },
  steps: [
    { keyword: "Given", text: "a paid listing has one place left" },
    { keyword: "When", text: "a customer payment is confirmed" },
    { keyword: "Then", text: "the customer receives a ticket" },
  ],
  story: {
    description:
      "Customers get a clear result when the last place is taken during payment.",
    id: "payments.capacity-after-payment",
    name: "Paid booking capacity",
    uri: "specs/payments/capacity.feature",
  },
} as const;

export const compileEvidenceFeature = (
  data: string,
): {
  catalog: ReturnType<typeof validateSpecSources>;
  document: ReturnType<typeof parseGherkinSource>;
  pickles: readonly Pickle[];
} => {
  const featureSource = source(data);
  const document = parseGherkinSource(
    featureSource,
    IdGenerator.incrementing(),
  );
  return {
    catalog: validateSpecSources([featureSource], registry),
    document,
    pickles: compile(document, featureSource.uri, IdGenerator.incrementing()),
  };
};
