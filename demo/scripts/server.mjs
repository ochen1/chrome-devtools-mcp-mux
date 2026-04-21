// Tiny local HTTP server for the demo. Serves /alpha and /bravo with distinct
// markers so we can visually tell which Chrome is driven by which client.
// Writes its port to $DEMO_WORK/port.txt.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const work = process.env.DEMO_WORK || '/tmp/cdmcp-mux-demo';
fs.mkdirSync(work, {recursive: true});

const srv = http.createServer((req, res) => {
  const url = req.url || '/';
  res.setHeader('content-type', 'text/html');
  if (url.startsWith('/alpha')) {
    res.end('<!doctype html><html><head><title>ALPHA</title></head><body><h1>alpha page</h1></body></html>');
  } else if (url.startsWith('/bravo')) {
    res.end('<!doctype html><html><head><title>BRAVO</title></head><body><h1>bravo page</h1></body></html>');
  } else {
    res.end('<!doctype html><html><body>ok</body></html>');
  }
});

srv.listen(0, '127.0.0.1', () => {
  const {port} = srv.address();
  fs.writeFileSync(path.join(work, 'port.txt'), String(port));
  console.log('demo server on port', port);
});
