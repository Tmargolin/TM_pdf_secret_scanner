// Generates the sample PDFs in tests/fixtures/ (DESIGN.md §15). No library:
// small, readable PDF 1.4 files with standard Helvetica text, built by hand,
// so every byte is known and reproducible.
//
//   npm run fixtures          → writes tests/fixtures/*.pdf
//
// Secrets: only AWS's documented example key (AKIAIOSFODNN7EXAMPLE) – public,
// not a real credential, and allowed by GitHub secret scanning.
// A test checks that the committed files equal this generator's output.

import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** One page: lines of text, top to bottom. A line may be split into pieces drawn one after another. */
export type PageSpec = (string | string[])[];

/** Escapes text for a PDF string literal: ( ) and \ need a backslash. */
function pdfString(text: string): string {
  return `(${text.replace(/[\\()]/g, (c) => `\\${c}`)})`;
}

/** A minimal PDF with one Helvetica font and the given pages (an empty page has no text at all). */
export function buildPdf(pages: PageSpec[]): Uint8Array {
  const objects: string[] = [];
  const fontId = 3 + 2 * pages.length;
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  const kids = pages.map((_, i) => `${3 + 2 * i} 0 R`).join(' ');
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  pages.forEach((lines, i) => {
    const ops = lines.map((line) => (Array.isArray(line) ? line : [line]).map((piece) => `${pdfString(piece)} Tj`).join(' ') + ' T*');
    const content = lines.length === 0 ? '' : `BT /F1 12 Tf 72 720 Td 14 TL ${ops.join(' ')} ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${4 + 2 * i} 0 R >>`,
    );
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out); // ASCII only, so one byte per character
}

export const AWS_EXAMPLE_KEY = 'AKIAIOSFODNN7EXAMPLE';

/** Every fixture: file name → pages. */
export const FIXTURES: Record<string, PageSpec[]> = {
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
};

/** All fixtures as bytes (used by the tests to check the committed files). */
export function buildFixtures(): Map<string, Uint8Array> {
  return new Map(Object.entries(FIXTURES).map(([name, pages]) => [name, buildPdf(pages)]));
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
