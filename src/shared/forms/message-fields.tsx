import type { Child } from "#jsx/jsx-runtime.ts";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";

export const MessageFields = ({
  children,
}: {
  children?: Child;
}): JSX.Element => (
  <>
    <label>
      Message
      <textarea
        maxlength={MAX_TEXTAREA_LENGTH}
        name="message"
        required
      ></textarea>
    </label>
    {children}
    <button type="submit">Send message</button>
  </>
);
