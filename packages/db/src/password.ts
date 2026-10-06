import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

/**
 * Password hashing with scrypt from Node's crypto: no native dependency, and
 * the parameters travel with the hash so they can be raised later.
 * Format: scrypt$<N>$<salt base64url>$<hash base64url>
 */

const KEY_BYTES = 64;
const COST = 16384; // 2^14, about 50 ms on a laptop core

function derive(password: string, salt: Buffer, cost: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize("NFKC"), salt, KEY_BYTES, { N: cost, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, COST);
  return `scrypt$${COST}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false;
  const [scheme, costText, saltText, hashText] = stored.split("$");
  if (scheme !== "scrypt" || !costText || !saltText || !hashText) return false;
  const expected = Buffer.from(hashText, "base64url");
  const key = await derive(password, Buffer.from(saltText, "base64url"), Number(costText));
  return key.length === expected.length && timingSafeEqual(key, expected);
}
