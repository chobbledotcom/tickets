import { handleRequest } from "#routes";
import { stubCheckout } from "#test-utils/checkout.ts";

/** Send a form POST that must NOT start a checkout session: stub the payment
 *  checkout, run `request`, and return the response together with how many
 *  times checkout was attempted (the caller asserts this is 0), always
 *  restoring the stub afterwards. */
export const postExpectingNoCheckout = async (
  request: Request,
): Promise<{ response: Response; checkoutCalls: number }> => {
  const { checkout, calls } = stubCheckout("cs_should_not_run");
  try {
    const response = await handleRequest(request);
    return { checkoutCalls: calls(), response };
  } finally {
    checkout.restore();
  }
};
