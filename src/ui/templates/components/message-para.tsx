import { t } from "#i18n";

/** A paragraph holding one translated sentence, with its named values. */
export const MessageParagraph = ({
  messageKey,
  values,
}: {
  messageKey: string;
  values?: Record<string, string>;
}): JSX.Element => <p>{t(messageKey, values)}</p>;
