import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const publicFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ...['app', 'project', 'images', 'sample'].map(name => [
    `/${name}.js`, [`${name}.js`, 'text/javascript; charset=utf-8'],
  ]),
]);
const port = Number(process.env.PORT || 4173);
const server = createServer(async (request, response) => {
  const route = publicFiles.get(request.url.split('?')[0]);
  if (!route || !['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(404).end();
    return;
  }
  try {
    const [file, type] = route;
    const body = await readFile(new URL(`./public/${file}`, import.meta.url));
    response.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'",
    }).end(request.method === 'HEAD' ? undefined : body);
  } catch (error) {
    console.error(error);
    response.writeHead(500).end();
  }
});
server.listen(port, '127.0.0.1', () => console.log(`ドットキャラ制作室 http://127.0.0.1:${server.address().port}`));
