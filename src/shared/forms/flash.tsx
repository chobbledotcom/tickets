import { consumeFlash, getFlash } from "#shared/flash-context.ts";
import type { FlashFields } from "#shared/flash-fields.ts";
import { ErrorAlert } from "#templates/components/error.tsx";

export const Flash = ({ error, success, info }: FlashFields): JSX.Element => {
  if (error || success || info) consumeFlash();
  return (
    <>
      {success ? (
        <div class="success" role="alert">
          {success}
        </div>
      ) : null}
      {info ? (
        <div class="info" role="alert">
          {info}
        </div>
      ) : null}
      {error ? <ErrorAlert>{error}</ErrorAlert> : null}
    </>
  );
};

/** The Flash notice for a page's own message bag: null when the bag holds no
 *  message, so the page shows no notice at all. */
export const flashNotice = ({
  error,
  info,
  success,
}: FlashFields): JSX.Element | null => {
  if (error === undefined && info === undefined && success === undefined) {
    return null;
  }
  return <Flash error={error} info={info} success={success} />;
};

export const requestFlash = (): JSX.Element | null => flashNotice(getFlash());

/** Render one flash field as text, empty when there is no message. */
const renderFlash = (fields: FlashFields, message?: string): string =>
  message ? String(<Flash {...fields} />) : "";

export const renderError = (error?: string): string =>
  renderFlash({ error }, error);

export const renderSuccess = (message?: string): string =>
  renderFlash({ success: message }, message);
