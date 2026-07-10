import { expect } from "@std/expect";
import { getRefundPaymentReferences } from "#shared/db/payment-references.ts";
import { getTestPrivateKey } from "./crypto.ts";

export const expectRefundReferences = async (
  attendeeId: number,
  expectedReferences: string[],
) => {
  const references = await getRefundPaymentReferences(
    [{ id: attendeeId, payment_id: "" }],
    await getTestPrivateKey(),
  );
  expect(
    references.get(attendeeId)!.map((reference) => reference.reference),
  ).toEqual(expectedReferences);
};
