import { handleRequest } from "#routes";
import { followRedirect } from "#test-utils/assertions.ts";
import { mockRequest } from "#test-utils/mocks.ts";

/**
 * Runs the payment-success flow for a checkout session: hits
 * /payment/success, follows the redirect, and returns both responses plus the
 * final page HTML so a test can assert on each stage.
 */
export const renderPaymentSuccess = async (
  sessionId: string,
): Promise<{
  redirectResponse: Response;
  response: Response;
  html: string;
}> => {
  const redirectResponse = await handleRequest(
    mockRequest(`/payment/success?session_id=${sessionId}`),
  );
  const response = await followRedirect(redirectResponse, handleRequest);
  return { html: await response.text(), redirectResponse, response };
};
