import { expect } from "@std/expect";
import { validateSpecSources } from "#scripts/specs/profile.ts";
import type { SpecRegistry, SpecSource } from "#scripts/specs/types.ts";

export const registry: SpecRegistry = {
  actors: ["customer", "organiser"],
  editions: ["managed", "self-hosted"],
  owners: ["payments"],
  risks: ["high", "medium", "low"],
  surfaces: ["return", "webhook"],
};

export const validFeature = `
@story:payments.capacity-after-payment
@owner:payments @risk:high
@actor:customer @actor:organiser
@edition:managed @edition:self-hosted
Feature: Paid booking capacity
  Customers get a clear result when the last place is taken during payment.

  @rule:payments.available-place-is-booked
  Rule: A paid customer receives a place while one remains
    The confirmed payment creates the promised booking.

    @case:payment.place-available
    Scenario: Payment is confirmed before the last place is taken
      Given a paid listing has one place left
      When a customer payment is confirmed
      Then the customer receives a ticket
`;

export const source = (
  data = validFeature,
  uri = "specs/payments/capacity.feature",
): SpecSource => ({ data, uri });

export const replace = (from: string, to: string): string =>
  validFeature.replace(from, to);

export const outlineFeature = validFeature.replace(
  / {4}@case:[\s\S]*$/,
  `    Scenario Outline: Payment result <case_id>
      Given a paid listing has <places> places left
      When a customer payment is confirmed
      Then the customer receives a ticket

      Examples:
        | case_id          | places |
        | payment.one-left | 1      |
        | payment.two-left | 2      |
`,
);

export const expectInvalid = (data: string, message: string): void => {
  expect(() => validateSpecSources([source(data)], registry)).toThrow(message);
};
