/** The longest message the compose box offers and the send route accepts.
 * Roughly seven concatenated SMS segments, far past anything a text to one
 * person needs. The browser control and the route read the same constant, so
 * a crafted POST cannot send what the form can never compose. */
export const SMS_MESSAGE_MAX_LENGTH = 1000;
