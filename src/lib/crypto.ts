import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';

/**
 * Шифрування токенів еквайрингу клубів.
 *
 * Токен mono дає доступ до чужих грошей. У базі він лежить тільки
 * зашифрованим: витік дампа не має віддавати чужий еквайринг.
 *
 * Ключ — змінна оточення PAYMENTS_SECRET. Будь-який рядок довжиною
 * від 16 символів; у ключ AES він перетворюється через SHA-256.
 * Зміна PAYMENTS_SECRET робить усі збережені токени нечитабельними —
 * клубам доведеться ввести їх заново.
 */

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

function key(): Buffer {
  const secret = process.env.PAYMENTS_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error('PAYMENTS_SECRET не задано або коротший за 16 символів');
  }
  return createHash('sha256').update(secret).digest();
}

/** Повертає base64: iv | tag | ciphertext */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(IV_LEN);
  const c = createCipheriv(ALGO, key(), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}

export function decryptSecret(packed: string): string {
  const buf = Buffer.from(packed, 'base64');
  if (buf.length <= IV_LEN + TAG_LEN) throw new Error('Пошкоджений шифротекст');

  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const data = buf.subarray(IV_LEN + TAG_LEN);

  const d = createDecipheriv(ALGO, key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}

/** Чи налаштоване шифрування взагалі — щоб на старті сказати це вголос */
export function paymentsSecretReady(): boolean {
  const s = process.env.PAYMENTS_SECRET;
  return Boolean(s && s.length >= 16);
}
