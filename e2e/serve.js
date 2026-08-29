// Petit serveur statique pour l'E2E "renderer" : sert src/renderer/ sur un port local.
// (On passe par HTTP et non file:// pour que la CSP `script-src 'self'` soit satisfaite.)
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'src', 'renderer');
const PORT = Number(process.env.E2E_PORT || 5177);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

http
    .createServer((req, res) => {
        let rel = decodeURIComponent((req.url || '/').split('?')[0]);
        if (rel === '/' || rel === '') rel = '/index.html';
        const file = path.join(ROOT, path.normalize(rel));
        if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }
        fs.readFile(file, (err, buf) => {
            if (err) { res.writeHead(404); return res.end('not found'); }
            res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
            res.end(buf);
        });
    })
    .listen(PORT, () => console.log('e2e static server on http://localhost:' + PORT));
