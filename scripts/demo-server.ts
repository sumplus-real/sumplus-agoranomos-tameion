import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const port = Number(process.env.DEMO_PORT ?? 4173);
const reportPath = resolve(root, process.env.DEMO_REPORT ?? 'private-data/replay/report.json');
createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'");
  try {
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path === '/api/report') {
      try {
        const report = JSON.parse(await readFile(reportPath, 'utf8'));
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ mode: 'historical_replay', report }));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ mode: 'synthetic', report: null }));
      }
      return;
    }
    const files: Record<string, string> = {'/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css'};
    if (!files[path]) { res.writeHead(404).end('Not found'); return; }
    res.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html');
    res.end(await readFile(resolve(root, 'demo', files[path])));
  } catch { res.writeHead(500).end('Report could not be read. Check the local replay output.'); }
}).listen(port, '127.0.0.1', () => console.log(`Agoranomos demo: http://127.0.0.1:${port}`));
