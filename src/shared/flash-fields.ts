/** The three optional flash messages a page or form can show — an error, a
 * success note, or a neutral info note. Present only when there is a message.
 * Shared by the {@link Flash} component and any page data that carries its own
 * flash straight into that component. */
export type FlashFields = {
  error?: string | undefined;
  success?: string | undefined;
  info?: string | undefined;
};
