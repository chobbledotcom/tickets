/**
 * Hidden form field that carries where to send the visitor after the form
 * runs. Renders nothing when there is no return URL.
 *
 * Lives on its own so both the shared form builders and the attendee table can
 * use it.
 */

export const ReturnUrlField = ({
  returnUrl,
}: {
  returnUrl?: string | undefined;
}): JSX.Element => (
  <>
    {returnUrl && <input name="return_url" type="hidden" value={returnUrl} />}
  </>
);
