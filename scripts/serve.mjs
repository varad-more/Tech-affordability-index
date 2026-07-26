#!/usr/bin/env node
/**
 * Minimal static server for local preview.
 *
 * ES modules and fetch() refuse to work from file://, so the page needs a real
 * HTTP origin even though the deployed artefact is just flat files.
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT ?? 4173);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/** True if the path exists and is a directory. */
async function isDir(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    let path = join(ROOT, rel);

    if (!path.startsWith(ROOT)) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    // Directory indexes, the way GitHub Pages does them: /timing/ serves
    // timing/index.html, and /timing redirects to /timing/ so that relative
    // links inside the page resolve against the directory rather than its
    // parent. Getting the redirect wrong locally would hide real broken links.
    if (await isDir(path)) {
      if (!url.pathname.endsWith('/')) {
        res.writeHead(301, { Location: `${url.pathname}/${url.search}` }).end();
        return;
      }
      path = join(path, 'index.html');
    }

    const body = await readFile(path);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(path)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
}).listen(PORT, () => {
  console.log(`Serving ${ROOT}\n  http://localhost:${PORT}`);
});
