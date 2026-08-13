import { expect } from "@std/expect";
import { describe, test } from "@std/testing/bdd";
import {
  type PaymentReference,
  paymentReferenceIndexInput,
  readPaymentReference,
  type TaggedPaymentReference,
  writePaymentReference,
} from "#shared/payment/provider-reference.ts";

const tagged = (
  provider: TaggedPaymentReference["provider"],
  reference: string,
): TaggedPaymentReference => ({ kind: "tagged", provider, reference });

describe("payment reference storage", () => {
  test("round-trips a tagged reference through the versioned envelope", () => {
    const reference = tagged("stripe", "pi_123");
    const stored = writePaymentReference(reference);

    expect(stored).toBe(
      'payment-reference:1:{"provider":"stripe","reference":"pi_123"}',
    );
    expect(readPaymentReference(stored, "payment row 7")).toEqual(reference);
  });

  test("serializes an enriched refund reference as its exact provider identity", () => {
    const identity = tagged("stripe", "pi_enriched");
    const enriched = {
      ...identity,
      index: "blind-index",
      rowSessionIds: ["session"],
    };

    expect(writePaymentReference(enriched)).toBe(
      writePaymentReference(identity),
    );
  });

  test("reads an old raw reference as explicitly untagged", () => {
    const expected: PaymentReference = {
      kind: "untagged",
      reference: "pi_before_tags",
    };
    expect(readPaymentReference("pi_before_tags", "payment row 8")).toEqual(
      expected,
    );
  });

  test("does not mistake a JSON-looking old reference for an envelope", () => {
    const raw = '{"provider":"square","reference":"pay_old"}';
    expect(readPaymentReference(raw, "legacy attendee 4")).toEqual({
      kind: "untagged",
      reference: raw,
    });
  });

  const malformed = [
    ["broken JSON", "{"],
    ["an unknown provider", '{"provider":"other","reference":"ref"}'],
    ["no provider", '{"reference":"ref"}'],
    ["no reference", '{"provider":"stripe"}'],
    ["a blank reference", '{"provider":"stripe","reference":""}'],
    [
      "whitespace in its reference",
      '{"provider":"stripe","reference":"pay 7"}',
    ],
    ["an extra field", '{"provider":"stripe","reference":"ref","extra":true}'],
  ] as const;
  for (const [description, payload] of malformed) {
    test(`refuses a prefixed envelope carrying ${description}`, () => {
      expect(() =>
        readPaymentReference(
          `payment-reference:1:${payload}`,
          "processed_payments.payment_reference",
        )
      ).toThrow("processed_payments.payment_reference");
    });
  }

  test("refuses to write a value outside the tagged schema", () => {
    const wrongProvider = {
      kind: "tagged",
      provider: "other",
      reference: "ref",
    } as unknown as TaggedPaymentReference;
    expect(() => writePaymentReference(wrongProvider)).toThrow(
      /^Invalid payment reference$/,
    );
  });

  test("refuses to write blank or whitespace reference ids", () => {
    for (const reference of ["", "pay 7"]) {
      expect(() => writePaymentReference(tagged("stripe", reference))).toThrow(
        /^Invalid payment reference$/,
      );
    }
  });
});

describe("payment reference identity", () => {
  test("is canonical and includes the provider", () => {
    const stripe = tagged("stripe", "shared_raw_id");
    const anotherStripe = tagged("stripe", "shared_raw_id");
    const square = tagged("square", "shared_raw_id");

    expect(paymentReferenceIndexInput(stripe)).toBe(
      paymentReferenceIndexInput(anotherStripe),
    );
    expect(paymentReferenceIndexInput(stripe)).not.toBe(
      paymentReferenceIndexInput(square),
    );
    expect(paymentReferenceIndexInput(stripe)).toBe(
      writePaymentReference(stripe),
    );
  });

  test("keeps an untagged reference's existing index input", () => {
    expect(
      paymentReferenceIndexInput({
        kind: "untagged",
        reference: "pi_before_tags",
      }),
    ).toBe("pi_before_tags");
  });
});
