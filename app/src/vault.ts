import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";

export type Sealed = { v: 1; salt: string; iv: string; tag: string; data: string };

export const MIN_PASSPHRASE = 12;
const SCRYPT = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };

export function newSalt(): string {
  return randomBytes(16).toString("base64");
}

export function deriveKey(passphrase: string, salt: string): Promise<Buffer> {
  if (passphrase.length < MIN_PASSPHRASE) return Promise.reject(new Error(`the sync passphrase needs at least ${MIN_PASSPHRASE} characters`));
  return new Promise((resolve, reject) =>
    scrypt(passphrase.normalize("NFC"), Buffer.from(salt, "base64"), 32, SCRYPT, (error, key) => (error ? reject(error) : resolve(key))),
  );
}

export function seal(payload: unknown, key: Buffer, salt: string, userId: string): Sealed {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(userId));
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return { v: 1, salt, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
}

export function open<T>(sealed: Sealed, key: Buffer, userId: string): T {
  if (sealed?.v !== 1) throw new Error("this vault was made by a newer open-eyes Browser");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64"));
  decipher.setAAD(Buffer.from(userId));
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
  try {
    const plain = Buffer.concat([decipher.update(Buffer.from(sealed.data, "base64")), decipher.final()]);
    return JSON.parse(plain.toString("utf8")) as T;
  } catch {
    throw new Error("could not open the synced data: the sync passphrase is wrong, or the data was changed");
  }
}
