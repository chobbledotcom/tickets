import { groups } from "#db/groups.ts";
import { handleRequest } from "#routes";
import { followRedirect } from "#test-utils/assertions.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
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

/**
 * Creates a package group whose member listings are hidden from public view,
 * the shared starting point for tests about concealed package members.
 */
export const createHiddenPackageGroup = async (name = "Bundle") => {
  const group = await createTestGroup({ isPackage: true, name });
  await groups.table.update(group.id, { hidePackageListings: true });
  return group;
};
