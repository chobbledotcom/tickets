import { t } from "#i18n";

/** The words a record's delete page shows above the name it asks for. */
export const deleteConfirmLabel = (record: { nameLabel?: string }): string => {
  if (record.nameLabel === undefined) {
    throw new Error("The record declares no delete confirmation label");
  }
  return t(record.nameLabel);
};
