#!/usr/bin/env node
// Serves test-pages/ on localhost for manual tests with the DEV build
// (DESIGN.md §12, docs/manual-tests.md).
//
//   npm run serve:test-pages        → http://localhost:8080/upload.html
//   PAGES_PORT=9000 npm run serve:test-pages
//
// Only files inside test-pages/ are served, only to this computer.

import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PAGES_PORT ?? 8080);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'test-pages');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.pdf': 'application/pdf' };

const server = http.createServer(async (req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
  const file = path.resolve(ROOT, `.${urlPath === '/' ? '/upload.html' : urlPath}`);
  // Refuse anything outside test-pages/ (e.g. /../package.json).
  if (!file.startsWith(ROOT + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
  console.log(`${res.statusCode} ${req.method} ${urlPath}`);
});

// Loopback only: the pages are not reachable from other computers.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Test pages: http://localhost:${PORT}/upload.html  (Ctrl+C to stop)`);
});
