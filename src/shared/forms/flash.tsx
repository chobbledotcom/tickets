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

export const requestFlash = (): JSX.Element | null => {
  const { error, info, success } = getFlash();
  return <Flash error={error} info={info} success={success} />;
};

export const renderError = (error?: string): string =>
  error ? String(<Flash error={error} />) : "";

export const renderSuccess = (message?: string): string =>
  message ? String(<Flash success={message} />) : "";
