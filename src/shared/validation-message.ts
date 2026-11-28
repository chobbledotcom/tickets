// effects: pure
import { errorMessage } from "#shared/error-message.ts";

/** Run a validator that throws on bad input. Return null when it accepts, or
 *  the thrown message when it refuses. A form uses this to turn a parser's
 *  refusal into its own error line. */
export const validationMessage = (validate: () => void): string | null => {
  try {
    validate();
    return null;
  } catch (error) {
    return errorMessage(error);
  }
};
