// Шифрование файла с данными. Тот же алгоритм повторён в app.js (браузер).
// Сжатие gzip → AES-256-GCM, ключ из фразы через PBKDF2-SHA256.
import { webcrypto as crypto } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";

export const ITERATIONS = 310000;

async function keyFrom(phrase, salt, iter) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(phrase.normalize("NFC")), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: iter, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export async function encrypt(obj, phrase) {
  if (!phrase || phrase.length < 12) throw new Error("Фраза слишком короткая (нужно от 12 символов)");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await keyFrom(phrase, salt, ITERATIONS);
  const packed = gzipSync(Buffer.from(JSON.stringify(obj), "utf8"));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, packed));
  return JSON.stringify({ v: 1, alg: "PBKDF2-SHA256/AES-256-GCM/gzip", iter: ITERATIONS,
    salt: Buffer.from(salt).toString("base64"), iv: Buffer.from(iv).toString("base64"), data: Buffer.from(ct).toString("base64") });
}

export async function decrypt(text, phrase) {
  const f = JSON.parse(text);
  const key = await keyFrom(phrase, Buffer.from(f.salt, "base64"), f.iter);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(f.iv, "base64") }, key, Buffer.from(f.data, "base64"));
  return JSON.parse(gunzipSync(Buffer.from(pt)).toString("utf8"));
}
