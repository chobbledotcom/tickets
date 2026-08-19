/* jscpd:ignore-start -- imports */
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import type { ProviderRead } from "#payment/provider-read.ts";
import type { ChargeMoney } from "#payment/resources.ts";
import { handleRequest } from "#routes";
import { sumupPaymentProvider } from "#shared/sumup-provider.ts";
import { getAllActivityLog } from "#test-utils/activity-log.ts";
import { expectFlashRedirect } from "#test-utils/assertions.ts";
import { mockFormRequest } from "#test-utils/mocks.ts";
import { foundCharge, fullyRefundedMoney } from "#test-utils/payment-state.ts";
import { testCookie, testCsrfToken } from "#test-utils/session.ts";
/* jscpd:ignore-end */

export const refundCasePath = (id: number): string =>
  `/admin/privacy/refunds/${id}`;

export const submitRefundCase = async (
  cookie: string,
  fields: Record<string, string> = {},
  id = 987_654_321,
): Promise<Response> =>
  handleRequest(
    mockFormRequest(
      refundCasePath(id),
      {
        choice: "provider_confirmed_returned",
        csrf_token: await testCsrfToken(),
        revision: "1",
        ...fields,
      },
      cookie,
    ),
  );

const providerCheck = (answer: ProviderRead<ChargeMoney>) => {
  const read = stub(sumupPaymentProvider, "readCharge", () =>
    Promise.resolve(answer),
  );
  const send = stub(sumupPaymentProvider, "refundCharge");
  return {
    read,
    send,
    [Symbol.dispose]: () => {
      send.restore();
      read.restore();
    },
  };
};

export const unreadableProviderCheck = () =>
  providerCheck({ reason: "timeout", status: "unavailable" });

export const returnedProviderCheck = () =>
  providerCheck(foundCharge(fullyRefundedMoney(2_500)));

export const expectProviderCheck = async (
  id: number,
  provider: ReturnType<typeof providerCheck>,
  flashMessage: string,
  activityMessage?: string,
): Promise<void> => {
  await expectFlashRedirect(
    refundCasePath(id),
    flashMessage,
    false,
  )(await submitRefundCase(await testCookie(), { choice: "check_again" }, id));
  expect(provider.read.calls).toHaveLength(1);
  expect(provider.send.calls).toHaveLength(0);
  if (activityMessage) {
    expect((await getAllActivityLog()).map(({ message }) => message)).toContain(
      activityMessage,
    );
  }
};

export const expectStaleProviderCheckRefused = async <Stored>(
  id: number,
  expected: Stored,
  load: () => Promise<Stored>,
): Promise<void> => {
  using read = stub(sumupPaymentProvider, "readCharge");
  using send = stub(sumupPaymentProvider, "refundCharge");
  await expectFlashRedirect(
    refundCasePath(id),
    "This refund changed while you were checking it. Read the current details and choose again.",
    false,
  )(
    await submitRefundCase(
      await testCookie(),
      { choice: "check_again", revision: "1" },
      id,
    ),
  );

  expect(read.calls).toHaveLength(0);
  expect(send.calls).toHaveLength(0);
  expect(await load()).toEqual(expected);
};
