/**
 * Two error-styled boxes, kept distinct on purpose.
 *
 * {@link ErrorAlert} is a live failure the operator just triggered. It is
 * announced assertively and is focusable, so the browser scrolls straight to
 * the first one: the no-JavaScript "jump to the error". {@link ErrorNote} is a
 * standing caution styled like an error, so it is not announced, animated, or
 * focused.
 *
 * Only the FIRST `autofocus` element on a page takes focus. A form field that
 * autofocuses above an error must give up its autofocus, or it wins that race.
 */

import type { Child } from "#jsx/jsx-runtime.ts";

/** The shared shape of both error boxes: just the message to show inside. */
type ErrorBoxProps = { children?: Child };

/** A live error alert: focusable, announced, and animated. See the file header. */
export const ErrorAlert = ({ children }: ErrorBoxProps): JSX.Element => (
  <div autofocus class="error" role="alert" tabindex="-1">
    {children}
  </div>
);

/** A standing note styled like an error: calm, not a focus target. See the
 * file header. */
export const ErrorNote = ({ children }: ErrorBoxProps): JSX.Element => (
  <div class="error">{children}</div>
);
