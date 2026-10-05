import type { Response } from 'express';

export const RECEIPT_MAX_BYTES = 5 * 1024 * 1024;
export const RECEIPT_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const;

/** Тип за вмістом (magic bytes), а не за заявленим Content-Type. */
export function sniffReceipt(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.toString('ascii', 0, 5) === '%PDF-') return 'application/pdf';
  return null;
}

/** Файл квитанції: inline, без sniffing, у пісочниці (CSP sandbox). */
export function sendReceiptFile(res: Response, mime: string, data: Buffer | Uint8Array) {
  const buf = Buffer.from(data);
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Length', String(buf.length));
  res.setHeader('Content-Disposition', 'inline');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', 'sandbox');
  res.setHeader('Cache-Control', 'private, no-store');
  res.end(buf);
}
