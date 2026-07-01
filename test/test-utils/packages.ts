/** Package booking-flow test helpers. */

/**
 * Drive the public checkout submit for a package group: GET the package page
 * (seeding the CSRF token the POST needs), then POST the booking form fields.
 * Callers pass `package_quantity` plus any date/day-count/contact fields.
 */
export const submitPackageBooking = async (
  slug: string,
  fields: Record<string, string>,
): Promise<Response> => {
  const { handleRequest } = await import("#routes");
  const { mockRequest, mockTicketFormRequest } = await import(
    "#test-utils/mocks.ts"
  );
  const { extractCsrfToken } = await import("#test-utils/csrf.ts");
  const pageHtml = await (
    await handleRequest(mockRequest(`/ticket/${slug}`))
  ).text();
  const csrf = extractCsrfToken(pageHtml)!;
  return handleRequest(mockTicketFormRequest(slug, fields, csrf));
};
