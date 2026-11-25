import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { generateEdits } from './pixel-model.mjs';

const publicFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ...['app', 'project', 'images', 'sample'].map(name => [
    `/${name}.js`, [`${name}.js`, 'text/javascript; charset=utf-8'],
  ]),
]);
const port = Number(process.env.PORT || 4173);
function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function editRoute(request, response) {
  const host = request.headers.host;
  const actualPort = server.address().port;
  if (![`127.0.0.1:${actualPort}`, `localhost:${actualPort}`].includes(host)
    || request.headers.origin !== `http://${host}`) {
    return json(response, 403, { error: 'ローカルの制作画面から実行してください。' });
  }
  if (request.headers['content-type'] !== 'application/json') {
    return json(response, 415, { error: 'JSONの入力が必要です。' });
  }
  let body = '';
  try {
    request.setEncoding('utf8');
    for await (const chunk of request) {
      body += chunk;
      if (body.length > 12000) {
        json(response, 413, { error: '入力サイズが上限を超えています。' });
        return;
      }
    }
    body = JSON.parse(body);
  } catch {
    return json(response, 400, { error: '入力を読み込めません。' });
  }
  const { status, ...result } = await generateEdits(body);
  json(response, status, result);
}

const server = createServer(async (request, response) => {
  if (request.method === 'POST' && request.url === '/api/pixel-edits') {
    await editRoute(request, response);
    return;
  }
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
