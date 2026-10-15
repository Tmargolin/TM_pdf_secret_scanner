// Generates the sample PDFs in tests/fixtures/ (DESIGN.md §12). No library:
// small, readable PDF 1.4 files with standard Helvetica text, built by hand,
// so every byte is known and reproducible.
//
//   npm run fixtures          → writes tests/fixtures/*.pdf
//
// Secrets: only AWS's documented example key (AKIAIOSFODNN7EXAMPLE) – public,
// not a real credential, and allowed by GitHub secret scanning.
// A test checks that the committed files equal this generator's output.

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * One page: lines of text, top to bottom (a line may be split into pieces
 * drawn one after another), or `{ draw }` – raw drawing operators and no text
 * at all, like a scanned page.
 */
export type PageSpec = (string | string[])[] | { draw: string };

/** Standard security handler, revision 2 (RC4, 40-bit) – PDF 1.4 spec, algorithms 3.2–3.4. */
export interface Encryption {
  /** Needed to open the file; '' = opens without a password (owner password only). */
  userPassword: string;
  ownerPassword: string;
}

/** Escapes text for a PDF string literal: ( ) and \ need a backslash. */
function pdfString(text: string): string {
  return `(${text.replace(/[\\()]/g, (c) => `\\${c}`)})`;
}

// ---------- encryption (only for fixtures; not used by the extension) ----------

const PASSWORD_PAD = Buffer.from('28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A', 'hex');
const md5 = (...parts: Buffer[]) => createHash('md5').update(Buffer.concat(parts)).digest();
const padPassword = (password: string) => Buffer.concat([Buffer.from(password, 'latin1'), PASSWORD_PAD]).subarray(0, 32);

function rc4(key: Buffer, data: Buffer): Buffer {
  const s = Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i]! + key[i % key.length]!) & 255;
    [s[i], s[j]] = [s[j]!, s[i]!];
  }
  const out = Buffer.alloc(data.length);
  let i = 0;
  j = 0;
  for (let n = 0; n < data.length; n++) {
    i = (i + 1) & 255;
    j = (j + s[i]!) & 255;
    [s[i], s[j]] = [s[j]!, s[i]!];
    out[n] = data[n]! ^ s[(s[i]! + s[j]!) & 255]!;
  }
  return out;
}

const PERMISSIONS = -44; // printing and copying not allowed – typical for "protected" PDFs
const FILE_ID = md5(Buffer.from('pss-fixture')); // fixed, so the output is reproducible

function securityHandler(encryption: Encryption) {
  const owner = rc4(md5(padPassword(encryption.ownerPassword)).subarray(0, 5), padPassword(encryption.userPassword)); // 3.3
  const permissions = Buffer.alloc(4);
  permissions.writeInt32LE(PERMISSIONS);
  const key = md5(padPassword(encryption.userPassword), owner, permissions, FILE_ID).subarray(0, 5); // 3.2
  const user = rc4(key, PASSWORD_PAD); // 3.4
  const objectKey = (n: number) => md5(key, Buffer.from([n & 255, (n >> 8) & 255, (n >> 16) & 255, 0, 0])).subarray(0, 10);
  return {
    dictionary: `<< /Filter /Standard /V 1 /R 2 /O <${owner.toString('hex')}> /U <${user.toString('hex')}> /P ${PERMISSIONS} >>`,
    encryptStream: (objectNumber: number, data: string) => rc4(objectKey(objectNumber), Buffer.from(data, 'latin1')).toString('latin1'),
  };
}

// ---------- PDF ----------

/** A minimal PDF with one Helvetica font and the given pages; optionally encrypted. */
export function buildPdf(pages: PageSpec[], options: { encryption?: Encryption } = {}): Uint8Array {
  const security = options.encryption ? securityHandler(options.encryption) : null;
  const objects: string[] = [];
  const fontId = 3 + 2 * pages.length;
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  const kids = pages.map((_, i) => `${3 + 2 * i} 0 R`).join(' ');
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  pages.forEach((page, i) => {
    let content: string;
    if ('draw' in page) content = page.draw;
    else {
      const ops = page.map((line) => (Array.isArray(line) ? line : [line]).map((piece) => `${pdfString(piece)} Tj`).join(' ') + ' T*');
      content = page.length === 0 ? '' : `BT /F1 12 Tf 72 720 Td 14 TL ${ops.join(' ')} ET`;
    }
    const contentId = 4 + 2 * i;
    if (security) content = security.encryptStream(contentId, content);
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`,
    );
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const encryptId = security ? objects.push(security.dictionary) : 0;

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  const encryptEntries = security ? ` /Encrypt ${encryptId} 0 R /ID [<${FILE_ID.toString('hex')}> <${FILE_ID.toString('hex')}>]` : '';
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${encryptEntries} >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, 'latin1')); // one byte per character (encrypted streams are binary)
}

export const AWS_EXAMPLE_KEY = 'AKIAIOSFODNN7EXAMPLE';

/** Every fixture: file name → pages (and encryption). */
export const FIXTURES: Record<string, PageSpec[] | { pages: PageSpec[]; encryption: Encryption }> = {
  'one-page.pdf': [['Hello from a one-page PDF.']],
  'multi-page.pdf': [
    ['Page one: introduction.'],
    ['Page two: configuration', `aws_access_key_id = ${AWS_EXAMPLE_KEY}`],
    ['Page three: the end.'],
  ],
  'multi-line.pdf': [['First line', 'Second line', 'Third line']],
  'split-token.pdf': [[['key ', AWS_EXAMPLE_KEY.slice(0, 8), AWS_EXAMPLE_KEY.slice(8)]]],
  'special-chars.pdf': [['Parentheses (like these) and a back\\slash']],
  'empty-page-between.pdf': [['Before the empty page'], [], ['After the empty page']],
  // 5.2 – PDFs that cannot be scanned (or can, though they look like they cannot)
  'encrypted.pdf': { pages: [[`Behind a password: ${AWS_EXAMPLE_KEY}`]], encryption: { userPassword: 'secret', ownerPassword: 'owner' } },
  'owner-password-only.pdf': { pages: [['Restricted, but readable']], encryption: { userPassword: '', ownerPassword: 'owner' } },
  'no-text.pdf': [{ draw: '0.2 0.4 0.6 rg 72 600 300 120 re f 0 0 0 RG 2 w 72 560 m 372 560 l S' }],
};

/** All fixtures as bytes (used by the tests to check the committed files). */
export function buildFixtures(): Map<string, Uint8Array> {
  return new Map(
    Object.entries(FIXTURES).map(([name, spec]) => [
      name,
      Array.isArray(spec) ? buildPdf(spec) : buildPdf(spec.pages, { encryption: spec.encryption }),
    ]),
  );
}

// Run as a script: write the files.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const dir = new URL('../tests/fixtures/', import.meta.url);
  await mkdir(dir, { recursive: true });
  for (const [name, bytes] of buildFixtures()) {
    await writeFile(new URL(name, dir), bytes);
    console.log(`wrote tests/fixtures/${name} (${bytes.length} bytes)`);
  }
}
