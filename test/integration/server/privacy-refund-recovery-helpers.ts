/* jscpd:ignore-start -- imports */
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import type { ProviderRead } from "#shared/payment/provider-read.ts";
import type { ChargeMoney } from "#shared/payment/resources.ts";
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

const providerCheck = (
  answer: ProviderRead<ChargeMoney>,
  sendError: string,
) => {
  const read = stub(sumupPaymentProvider, "readCharge", () =>
    Promise.resolve(answer),
  );
  const send = stub(sumupPaymentProvider, "refundCharge", () => {
    throw new Error(sendError);
  });
  return {
    read,
    send,
    [Symbol.dispose]: () => {
      send.restore();
      read.restore();
    },
  };
};

export const unreadableProviderCheck = (sendError: string) =>
  providerCheck({ reason: "timeout", status: "unavailable" }, sendError);

export const returnedProviderCheck = (sendError: string) =>
  providerCheck(foundCharge(fullyRefundedMoney(2_500)), sendError);

export const expectUnreadableProviderCheck = async (
  id: number,
  provider: ReturnType<typeof unreadableProviderCheck>,
  flashMessage: string,
  activityMessage: string,
): Promise<void> => {
  await expectFlashRedirect(
    refundCasePath(id),
    flashMessage,
    false,
  )(await submitRefundCase(await testCookie(), { choice: "check_again" }, id));
  expect(provider.read.calls).toHaveLength(1);
  expect(provider.send.calls).toHaveLength(0);
  expect((await getAllActivityLog()).map(({ message }) => message)).toContain(
    activityMessage,
  );
};
