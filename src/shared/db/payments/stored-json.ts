/* jscpd:ignore-start -- imports */
import type * as v from "valibot";
import { decrypt, encrypt } from "#shared/crypto/encryption.ts";
import { hmacHash } from "#shared/crypto/hashing.ts";
import type { BlindIndex, EnvKeyEncrypted } from "#shared/crypto/sealed.ts";
import {
  defineStoredJson,
  type StoredJson,
} from "#shared/validation/stored-json.ts";
/* jscpd:ignore-end */

export interface EncryptedStoredJson<TSchema extends v.GenericSchema> {
  index: (value: v.InferInput<TSchema>, context: string) => Promise<BlindIndex>;
  open: (
    value: EnvKeyEncrypted,
    context: string,
  ) => Promise<v.InferOutput<TSchema>>;
  seal: StoreJson<TSchema, EnvKeyEncrypted>;
  sealIndexed: StoreJson<
    TSchema,
    { ciphertext: EnvKeyEncrypted; index: BlindIndex }
  >;
}

type StoreJson<TSchema extends v.GenericSchema, Output> = (
  value: v.InferInput<TSchema>,
  context: string,
) => Promise<Output>;

const seal = async <TSchema extends v.GenericSchema>(
  json: StoredJson<TSchema>,
  value: v.InferInput<TSchema>,
  context: string,
): Promise<{ ciphertext: EnvKeyEncrypted; plaintext: string }> => {
  const plaintext = json.write(value, context);
  return { ciphertext: await encrypt(plaintext), plaintext };
};

export const defineEncryptedStoredJson = <TSchema extends v.GenericSchema>(
  schema: TSchema,
): EncryptedStoredJson<TSchema> => {
  const json = defineStoredJson(schema);
  return {
    index: (value, context) => hmacHash(json.write(value, context)),
    open: async (value, context) => json.read(await decrypt(value), context),
    seal: async (value, context) =>
      (await seal(json, value, context)).ciphertext,
    sealIndexed: async (value, context) => {
      const stored = await seal(json, value, context);
      return {
        ciphertext: stored.ciphertext,
        index: await hmacHash(stored.plaintext),
      };
    },
  };
};
