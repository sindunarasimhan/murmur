import { createServer } from 'node:http';

const port = Number(process.env.MURMUR_PREVIEW_PORT ?? 8092);
const metro = process.env.MURMUR_EXPO_URL ?? 'http://127.0.0.1:8081';
createServer(async (request, response) => {
  if (request.url?.startsWith('/assets/')) {
    const asset = await fetch(`${metro}${request.url}`);
    response.writeHead(asset.status, { 'Content-Type': asset.headers.get('content-type') ?? 'application/octet-stream' });
    response.end(Buffer.from(await asset.arrayBuffer()));
    return;
  }
  response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
  response.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Murmur detail state preview</title><style>html,body,#root{margin:0;width:100%;height:100%;}#root{display:flex;}</style></head><body><div id="root"></div><script src="${metro}/scripts/detail-voice-preview.bundle?platform=web&dev=true&hot=false&transform.engine=hermes&transform.routerRoot=src%2Fapp"></script></body></html>`);
}).listen(port, '127.0.0.1', () => console.log(`Detail state preview http://127.0.0.1:${port}. This fixture does not capture audio.`));
