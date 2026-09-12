/**
 * The ticket image route is the only place a member-supplied file is stored
 * and served back, so it gets tested the way an attacker would probe it:
 * wrong credentials, wrong role, disguised file types, and paths that try to
 * leave the upload directory.
 */
import { describe, it, expect, beforeEach, afterAll, beforeAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { prisma } from '../lib/prisma.js';
import { env } from '../lib/env.js';
import { resetDatabase, makeUser, makeWeek } from '../test/fixtures.js';
import { signAccessToken } from '../lib/auth.js';
import { buildServer } from '../server.js';
import { sniffImageType, resolveWithinUploadDir, ticketImageFilename, readTicketImage, UnsafePathError } from '../lib/imageFiles.js';

// Smallest valid headers for each permitted format, padded past the 12-byte
// minimum the sniffer needs.
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(16)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(16)]);
const HEIC = Buffer.concat([Buffer.alloc(4), Buffer.from('ftyp'), Buffer.from('heic'), Buffer.alloc(16)]);

const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const HTML = Buffer.from('<!doctype html><script>alert(document.cookie)</script>');
const PDF = Buffer.concat([Buffer.from('%PDF-1.7'), Buffer.alloc(16)]);

let app: Awaited<ReturnType<typeof buildServer>>;
let uploadDir: string;
let admin: Awaited<ReturnType<typeof makeUser>>;
let member: Awaited<ReturnType<typeof makeUser>>;
let week: Awaited<ReturnType<typeof makeWeek>>;

beforeAll(async () => {
  // The directory the application is actually configured to use, set in
  // src/test/setup.ts before any module reads it.
  uploadDir = env.uploadDir;
  await fs.mkdir(uploadDir, { recursive: true });
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await fs.rm(uploadDir, { recursive: true, force: true });
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDatabase();
  week = await makeWeek();
  admin = await makeUser('Austin', 'ADMIN');
  member = await makeUser('Tanner');
});

const tokenFor = (u: { id: string; role: string; displayName: string }) =>
  signAccessToken({ sub: u.id, role: u.role as 'MEMBER' | 'ADMIN', name: u.displayName });

async function makeTicket(status: 'UPLOADED' | 'CONFIRMED', bytes = JPEG) {
  const filePath = path.join(uploadDir, ticketImageFilename(week.id, 'image/jpeg'));
  await fs.writeFile(filePath, bytes);
  return prisma.officialTicket.create({
    data: {
      nflWeekId: week.id,
      imagePath: filePath,
      imageMimeType: 'image/jpeg',
      uploadedById: admin.id,
      status,
    },
  });
}

const get = (ticketId: string, token?: string) =>
  app.inject({
    method: 'GET',
    url: `/api/tickets/${ticketId}/image`,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

describe('ticket image route — who may see it', () => {
  it('refuses an anonymous request', async () => {
    const ticket = await makeTicket('CONFIRMED');
    const res = await get(ticket.id);
    expect(res.statusCode).toBe(401);
  });

  it('refuses a forged token', async () => {
    const ticket = await makeTicket('CONFIRMED');
    const res = await get(ticket.id, 'not.a.real.token');
    expect(res.statusCode).toBe(401);
  });

  it('lets an administrator see a ticket that is still under review', async () => {
    const ticket = await makeTicket('UPLOADED');
    const res = await get(ticket.id, tokenFor(admin));
    expect(res.statusCode).toBe(200);
  });

  it('hides an unconfirmed ticket from an ordinary member', async () => {
    const ticket = await makeTicket('UPLOADED');
    const res = await get(ticket.id, tokenFor(member));
    // 404 rather than 403, so the route cannot be used to discover which
    // weeks have a ticket waiting.
    expect(res.statusCode).toBe(404);
  });

  it('shows a member the ticket once the parlay is confirmed', async () => {
    const ticket = await makeTicket('CONFIRMED');
    const res = await get(ticket.id, tokenFor(member));
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
  });

  it('gives the same answer for a ticket that does not exist', async () => {
    const res = await get('does-not-exist', tokenFor(member));
    expect(res.statusCode).toBe(404);
  });
});

describe('ticket image route — how it is delivered', () => {
  it('sends headers that make the response inert', async () => {
    const ticket = await makeTicket('CONFIRMED');
    const res = await get(ticket.id, tokenFor(member));

    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['content-security-policy']).toContain('sandbox');
    // A ticket must never sit in a shared cache.
    expect(res.headers['cache-control']).toBe('private, no-store');
  });

  it('names the download from the week, not from anything the uploader chose', async () => {
    const ticket = await makeTicket('CONFIRMED');
    const res = await get(ticket.id, tokenFor(member));
    expect(res.headers['content-disposition']).toMatch(/^inline; filename="week-\d+-\d+-ticket\.jpg"$/);
  });

  it('serves the bytes that are actually on disk', async () => {
    const ticket = await makeTicket('CONFIRMED', PNG);
    const res = await get(ticket.id, tokenFor(member));
    expect(res.statusCode).toBe(200);
    // The type follows the real bytes, not the "image/jpeg" recorded on the row.
    expect(res.headers['content-type']).toBe('image/png');
    expect(Buffer.from(res.rawPayload).equals(PNG)).toBe(true);
  });

  it('reports a missing file honestly instead of serving nothing', async () => {
    const ticket = await makeTicket('CONFIRMED');
    await fs.rm(ticket.imagePath);
    const res = await get(ticket.id, tokenFor(member));
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('IMAGE_UNAVAILABLE');
  });
});

describe('ticket image route — hostile content', () => {
  it('will not serve a disguised HTML file', async () => {
    // Even if such a file reached disk, serving it as HTML on the API origin
    // would be stored cross-site scripting. The sniffer refuses to type it.
    const ticket = await makeTicket('CONFIRMED', HTML);
    const res = await get(ticket.id, tokenFor(member));
    expect(res.statusCode).toBe(404);
  });

  it('will not serve an SVG, which can carry script', async () => {
    const ticket = await makeTicket('CONFIRMED', SVG);
    const res = await get(ticket.id, tokenFor(member));
    expect(res.statusCode).toBe(404);
  });

  it('will not serve a PDF', async () => {
    const ticket = await makeTicket('CONFIRMED', PDF);
    const res = await get(ticket.id, tokenFor(member));
    expect(res.statusCode).toBe(404);
  });
});

describe('ticket image route — path safety', () => {
  it('refuses to read a stored path outside the upload directory', async () => {
    const outside = path.join(os.tmpdir(), `fcp-outside-${Date.now()}.jpg`);
    await fs.writeFile(outside, JPEG);
    try {
      const ticket = await prisma.officialTicket.create({
        data: { nflWeekId: week.id, imagePath: outside, uploadedById: admin.id, status: 'CONFIRMED' },
      });
      const res = await get(ticket.id, tokenFor(admin));
      expect(res.statusCode).toBe(404);
    } finally {
      await fs.rm(outside, { force: true });
    }
  });

  it('refuses a traversal path even when it points at a real file', async () => {
    const ticket = await prisma.officialTicket.create({
      data: {
        nflWeekId: week.id,
        imagePath: path.join(uploadDir, '..', '..', 'etc', 'passwd'),
        uploadedById: admin.id,
        status: 'CONFIRMED',
      },
    });
    const res = await get(ticket.id, tokenFor(admin));
    expect(res.statusCode).toBe(404);
  });
});

describe('image identification', () => {
  it.each([
    ['JPEG', JPEG, 'image/jpeg'],
    ['PNG', PNG, 'image/png'],
    ['GIF', GIF, 'image/gif'],
    ['WebP', WEBP, 'image/webp'],
    ['HEIC', HEIC, 'image/heic'],
  ])('recognises %s', (_name, bytes, expected) => {
    expect(sniffImageType(bytes as Buffer)).toBe(expected);
  });

  it.each([
    ['SVG', SVG],
    ['HTML', HTML],
    ['PDF', PDF],
    ['empty', Buffer.alloc(0)],
    ['too short to judge', Buffer.from([0xff, 0xd8])],
  ])('refuses %s', (_name, bytes) => {
    expect(sniffImageType(bytes as Buffer)).toBeNull();
  });

  it('builds a filename containing nothing the uploader chose', () => {
    const name = ticketImageFilename('../../etc/passwd', 'image/png');
    expect(name).not.toContain('/');
    expect(name).not.toContain('..');
    expect(name).toMatch(/^ticket-etcpasswd-\d+\.png$/);
  });
});

describe('upload directory containment', () => {
  it('accepts a path inside the directory', () => {
    expect(resolveWithinUploadDir('/srv/uploads', '/srv/uploads/ticket.jpg')).toBe('/srv/uploads/ticket.jpg');
  });

  it('rejects a sibling directory that merely shares a prefix', () => {
    // "/srv/uploads-evil" must not pass a naive startsWith check.
    expect(() => resolveWithinUploadDir('/srv/uploads', '/srv/uploads-evil/ticket.jpg')).toThrow(UnsafePathError);
  });

  it('rejects traversal out of the directory', () => {
    expect(() => resolveWithinUploadDir('/srv/uploads', '/srv/uploads/../../etc/passwd')).toThrow(UnsafePathError);
  });

  it('returns null rather than throwing when reading an unsafe path', async () => {
    expect(await readTicketImage(uploadDir, '/etc/passwd')).toBeNull();
  });
});
