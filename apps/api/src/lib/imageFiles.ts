/**
 * Ticket image handling.
 *
 * Uploaded ticket photos are the only place where a member-supplied file is
 * stored and later served back, so both ends are treated as untrusted:
 *
 *   - The browser's declared Content-Type is never believed. The real type is
 *     read from the file's own leading bytes, both when storing and when
 *     serving.
 *   - Only raster photo formats are allowed. SVG and PDF are deliberately
 *     excluded because both can carry script, which would become stored
 *     cross-site scripting on the API's own origin.
 *   - Nothing the uploader controls is ever used to build a path on disk.
 */
import path from 'node:path';
import fs from 'node:fs/promises';

/** The only formats a ticket photo may be. */
export type TicketImageType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' | 'image/heic';

const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1']);

/**
 * Identify a file from its leading bytes. Returns null for anything that is
 * not a permitted image, including files whose extension or declared type
 * claims otherwise.
 */
export function sniffImageType(buffer: Buffer): TicketImageType | null {
  if (buffer.length < 12) return null;

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }

  // GIF: "GIF87a" or "GIF89a"
  if (buffer.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';

  // WebP: "RIFF" .... "WEBP"
  if (buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') {
    return 'image/webp';
  }

  // HEIC/HEIF, which is what an iPhone photo usually is: "ftyp" at offset 4,
  // followed by a brand that identifies the still-image flavours.
  if (buffer.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = buffer.subarray(8, 12).toString('latin1').toLowerCase();
    if (HEIF_BRANDS.has(brand)) return 'image/heic';
  }

  return null;
}

const EXTENSIONS: Record<TicketImageType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/heic': 'heic',
};

export function extensionFor(type: TicketImageType): string {
  return EXTENSIONS[type];
}

/**
 * Build the on-disk name for a stored ticket image.
 *
 * Nothing from the uploader reaches this name: it is composed entirely from a
 * database id, a timestamp and the sniffed type, so a hostile filename has
 * nowhere to go.
 */
export function ticketImageFilename(weekId: string, type: TicketImageType): string {
  const safeWeekId = weekId.replace(/[^a-zA-Z0-9]/g, '');
  return `ticket-${safeWeekId}-${Date.now()}.${extensionFor(type)}`;
}

export class UnsafePathError extends Error {}

/**
 * Resolve a stored path and prove it sits inside the upload directory.
 *
 * The path in the database was written by this application, so this is a
 * second line of defence rather than the first — but it means that even if a
 * bad path were ever stored, reading it could not escape the upload directory.
 */
export function resolveWithinUploadDir(uploadDir: string, storedPath: string): string {
  const root = path.resolve(uploadDir);
  const resolved = path.resolve(storedPath);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;

  if (resolved !== root && !resolved.startsWith(rootWithSep)) {
    throw new UnsafePathError(`Refusing to read ${storedPath}: it is outside the upload directory.`);
  }
  return resolved;
}

/** Read a stored ticket image, re-verifying its type from the bytes on disk. */
export async function readTicketImage(
  uploadDir: string,
  storedPath: string,
): Promise<{ bytes: Buffer; contentType: TicketImageType } | null> {
  let resolved: string;
  try {
    resolved = resolveWithinUploadDir(uploadDir, storedPath);
  } catch {
    return null;
  }

  let bytes: Buffer;
  try {
    bytes = await fs.readFile(resolved);
  } catch {
    return null;
  }

  // The type is decided by the bytes every time, never by the stored label.
  const contentType = sniffImageType(bytes);
  if (!contentType) return null;

  return { bytes, contentType };
}
