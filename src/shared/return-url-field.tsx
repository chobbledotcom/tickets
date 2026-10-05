/**
 * Hidden form field that carries where to send the visitor after the form
 * runs. Renders nothing when there is no return URL.
 *
 * Lives on its own so both the shared form builders and the attendee table can
 * use it.
 */

/** Append the return URL to an admin href, so the mutation lands the operator
 * back where they started. The twin of {@link ReturnUrlField}. */
export const withReturnUrl = (href: string, returnUrl: string): string =>
  `${href}?return_url=${encodeURIComponent(returnUrl)}`;

export const ReturnUrlField = ({
  returnUrl,
}: {
  returnUrl?: string | undefined;
}): JSX.Element => (
  <>
    {returnUrl && <input name="return_url" type="hidden" value={returnUrl} />}
  </>
);
