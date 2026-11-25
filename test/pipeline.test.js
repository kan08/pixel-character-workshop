import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { decodeGif, decodePng, encodeGif, nearestNeighbor } from '../pipeline/image-codecs.mjs';
import { runEngine } from '../pipeline/engines/sample-walk-engine.mjs';
import { readJson, writeJson } from '../pipeline/schema.mjs';
import { runLocal } from '../pipeline/workspace.mjs';

const execute = promisify(execFile);
const runner = fileURLToPath(new URL('../pipeline/runner.mjs', import.meta.url));

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'muse-2d-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function cli(root, args, options) {
  return execute(process.execPath, [runner, ...args, '--root', root], options);
}

function job(revision = 1, request = 'ルウの右向き歩き', extra = {}) {
  return {
    jobId: 'luu-walk', kind: 'animation', revision, baseRevision: revision === 1 ? null : revision - 1,
    request, inputs: {}, ...extra,
  };
}

function output(root, revision, filename) {
  return join(root, 'jobs', 'luu-walk', 'v' + revision, 'output', filename);
}

function statusOf(body) {
  const [marker, fence, ...rest] = body.split('\n');
  assert.equal(marker, '<!-- muse-2d-status -->');
  assert.equal(fence, '```json');
  return JSON.parse(rest.slice(0, rest.indexOf('```')).join('\n'));
}

function marked(type, payload) {
  return '<!-- muse-2d-' + type + ' -->\n```json\n' + JSON.stringify(payload) + '\n```';
}

test('Step 1 は inputs が空の job.json から透過 PNG と拡大プレビューを生成する', async t => {
  const root = await workspace(t);
  const file = join(root, 'job.json');
  await writeJson(file, {
    jobId: 'luu-base', revision: 1, baseRevision: null, kind: 'illustration',
    request: '言葉だけでルウの基準画を作って', inputs: {},
  });
  const { stdout } = await cli(root, ['run-local', '--job', file]);
  const outcome = JSON.parse(stdout);
  assert.equal(outcome.result.status, 'review');
  assert.ok(outcome.result.checks.every(check => check.status === 'pass'));
  const original = decodePng(await readFile(join(root, 'jobs/luu-base/v1/output/base.png')));
  const enlarged = decodePng(await readFile(join(root, 'preview/luu-base/v1/preview.png')));
  assert.deepEqual([original.width, original.height, enlarged.width, enlarged.height], [32, 32, 256, 256]);
  assert.ok(original.hasTransparency && original.hasVisiblePixels);
  assert.deepEqual(enlarged.pixels, nearestNeighbor(original.pixels, 32, 32, 8, 4));
  assert.match(await readFile(join(root, 'preview/luu-base/v1/index.html'), 'utf8'), /基準画 v1/);
});

test('歩き v1 とテンポ修正 v2 は4コマを保ち、GIF と JSON の時間が一致する', async t => {
  const root = await workspace(t);
  const base = await cli(root, ['run-local', '--job-id', 'luu-walk', '--kind', 'animation', '--request', '右向き歩き']);
  assert.equal(JSON.parse(base.stdout).result.status, 'review');
  const revisionArgs = ['run-local', '--job-id', 'luu-walk', '--kind', 'animation', '--rev', '2', '--base-rev', '1',
    '--request', 'テンポをゆっくりにして', '--keep', '絵と足の順番'];
  const revision = await cli(root, revisionArgs);
  assert.equal(JSON.parse(revision.stdout).result.status, 'review');
  assert.equal(JSON.parse((await cli(root, revisionArgs)).stdout).repeat, true);
  const savedJob = join(root, 'jobs/luu-walk/v2/job.json');
  assert.equal(JSON.parse((await cli(root, ['run-local', '--job', savedJob])).stdout).repeat, true);
  for (const [index, timing] of [[1, [120, 110, 120, 110]], [2, [180, 170, 180, 170]]]) {
    const metadata = await readJson(output(root, index, 'frames.json'));
    assert.deepEqual(metadata.frames.map(frame => frame.ms), timing);
    for (const [name, size] of [['walk.gif', 32], ['walk-preview.gif', 256]]) {
      const gif = decodeGif(await readFile(output(root, index, name)));
      assert.deepEqual([gif.width, gif.height, gif.loopCount], [size, size, 0]);
      assert.deepEqual(gif.frames.map(frame => frame.ms), timing);
    }
  }
  for (const name of ['frame-01.png', 'frame-02.png', 'frame-03.png', 'frame-04.png', 'frames.png']) {
    assert.deepEqual(await readFile(output(root, 1, name)), await readFile(output(root, 2, name)));
  }
  const html = await readFile(join(root, 'preview/luu-walk/v2/index.html'), 'utf8');
  assert.match(html, /前版 v1/);
  assert.match(html, /今回 v2/);
  assert.match(html, /180 ms/);
  assert.match(html, /name="viewport"/);
  assert.match(html, /prefers-color-scheme: dark/);
  assert.deepEqual(await readFile(join(root, 'preview/luu-walk/v2/previous-preview.gif')),
    await readFile(join(root, 'preview/luu-walk/v1/preview.gif')));
  for (const [, path] of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    await access(join(root, 'preview/luu-walk/v2', path));
  }
  assert.match(await readFile(join(root, 'preview/index.html'), 'utf8'), /luu-walk\/v2\/index.html/);
  assert.ok((await readdir(join(root, 'preview/luu-walk/v2'))).every(file => /\.(png|gif|html)$/.test(file)));
});

test('袖の修正は指定コマだけを差し替え、待機・まばたきと高速化も生成できる', async t => {
  const root = await workspace(t);
  await runLocal({ root, rawJob: job() });
  const sleeve = await runLocal({
    root, rawJob: job(2, '2コマ目の袖にハイライトを付けて', { step: 'step3-frames' }),
  });
  assert.equal(sleeve.result.status, 'review');
  for (const index of ['01', '02', '03', '04']) {
    const name = 'frame-' + index + '.png';
    assert.equal((await readFile(output(root, 1, name))).equals(await readFile(output(root, 2, name))), index !== '02');
  }
  const speed = await runLocal({ root, rawJob: job(3, 'テンポを速くして') });
  assert.equal(speed.result.status, 'review');
  const faster = await readJson(output(root, 3, 'frames.json'));
  assert.deepEqual(faster.frames.map(frame => frame.ms), [80, 70, 80, 70]);
  assert.deepEqual(await readFile(output(root, 2, 'frame-02.png')), await readFile(output(root, 3, 'frame-02.png')));
  const idle = await runLocal({ root, rawJob: job(4, '待機でまばたきを入れて') });
  assert.equal(idle.result.status, 'review');
  const gif = decodeGif(await readFile(output(root, 4, 'idle.gif')));
  assert.deepEqual(gif.frames.map(frame => frame.ms), [620, 100]);
  assert.notDeepEqual(await readFile(output(root, 4, 'frame-01.png')), await readFile(output(root, 4, 'frame-02.png')));
});

test('1コマ GIF は復号できても出荷を止める。正常な次版と採用は可能', async t => {
  const root = await workspace(t);
  const bad = await runLocal({
    root, rawJob: job(),
    engine: async args => {
      const output = await runEngine(args);
      const pixels = Buffer.alloc(32 * 32);
      const pngAsGif = encodeGif(32, 32, [[0, 0, 0], [255, 255, 255]], [{ pixels, ms: 120 }]);
      await writeFile(join(args.jobDir, 'output/walk.gif'), pngAsGif);
      return output;
    },
  });
  assert.equal(bad.result.status, 'blocked');
  assert.equal(bad.directory, null);
  assert.equal(bad.result.checks.find(check => check.name === 'gif-decode: output/walk.gif').status, 'pass');
  assert.equal(bad.result.checks.find(check => check.name === 'frame-count: output/walk.gif').status, 'fail');
  await assert.rejects(access(join(root, 'preview/luu-walk/v1/index.html')), { code: 'ENOENT' });
  await assert.rejects(cli(root, ['adopt', '--job-id', 'luu-walk', '--rev', '1']), /検品済みの版/);
  const fixed = await runLocal({ root, rawJob: job(2) });
  assert.equal(fixed.result.status, 'review');
});

test('GIF87a の静止画を読み戻せる。GIF と PNG の破損やシート範囲外を拒否する', async t => {
  const gif87a = Buffer.from('R0lGODdhAQABAIAAAAAAAP///ywAAAAAAQABAAACAkQBADs=', 'base64');
  assert.deepEqual(decodeGif(gif87a), {
    version: 'GIF87a', width: 1, height: 1, loopCount: null,
    frames: [{ x: 0, y: 0, width: 1, height: 1, ms: 0 }],
  });
  assert.throws(() => decodeGif(gif87a.subarray(0, -2)), /GIF/);
  assert.throws(() => decodePng(Buffer.alloc(33)), /PNG/);
  const root = await workspace(t);
  const outcome = await runLocal({
    root, rawJob: job(),
    engine: async args => {
      const result = await runEngine(args);
      const path = join(args.jobDir, 'output/frames.json');
      const metadata = await readJson(path);
      metadata.frames[0].rect.x = metadata.width;
      await writeJson(path, metadata);
      return result;
    },
  });
  assert.equal(outcome.result.status, 'blocked');
  assert.match(outcome.result.checks.find(check => check.name === 'sheet-json').detail, /シート範囲外/);
});

test('採用は冪等で、工程タグと再現条件を改善ログに追記できる', async t => {
  const root = await workspace(t);
  await runLocal({ root, rawJob: job() });
  const args = ['adopt', '--job-id', 'luu-walk', '--rev', '1'];
  const first = JSON.parse((await cli(root, args)).stdout);
  const second = JSON.parse((await cli(root, args)).stdout);
  assert.deepEqual(second, { ...first, repeat: true });
  assert.equal((await readJson(join(root, 'jobs/luu-walk/v1/result.json'))).status, 'adopted');
  const ledger = await readJson(join(root, 'jobs/luu-walk/adopted.json'));
  assert.equal(ledger.history.length, 1);
  assert.equal(ledger.revision, 1);
  await access(join(root, ledger.spriteSheet));
  await access(join(root, ledger.frameJson));

  await cli(root, ['log-improvement', '--step', 'step4-export', '--job-id', 'luu-walk', '--rev', '1',
    '--symptom', '書き出し結果が静止した', '--cause', '1コマだけ出力', '--action', 'GIF を読み戻して検品',
    '--expected', '2コマ未満は確認待ちにしない']);
  const log = await readFile(join(root, 'docs/improvement-log.md'), 'utf8');
  for (const value of ['step4-export', 'luu-walk v1', 'jobs/luu-walk/v1/job.json', '書き出し結果が静止した', 'GIF を読み戻して検品']) {
    assert.ok(log.includes(value));
  }
});

test('Issue の dry-run は Muse の確認通知を出力し、作業ツリーや GitHub に書かない', async t => {
  const root = await workspace(t);
  const issue = join(root, 'issue.json');
  await writeJson(issue, {
    id: 'I_13', number: 13, body: marked('job', { kind: 'animation', request: 'ルウの右向き歩き' }),
    author: { login: 'muse' }, comments: [],
  });
  const { stdout } = await cli(root, ['process-issue', '--repo', 'example/art-studio', '--issue', '13',
    '--preview-base-url', 'https://preview.example.invalid/2d/', '--dry-run', '--issue-file', issue]);
  const status = statusOf(stdout);
  assert.equal(status.status, 'review');
  assert.equal(status.eventId, 'issue:I_13');
  assert.equal(status.target, 'ルウ／右向き歩き v1');
  assert.equal(status.previewUrl, 'https://preview.example.invalid/2d/' + status.jobId + '/v1/index.html');
  assert.equal(status.checks.fail, 0);
  for (const field of ['対象版', '実物を見る', '検品', '見てほしい点', '返し方']) assert.ok(stdout.includes(field));
  assert.deepEqual(await readdir(root), ['issue.json']);
});

test('Issue 連携は配信を確認してから一度だけ投稿し、基準画採用からアニメ採用まで進む', async t => {
  const root = await workspace(t);
  const state = join(root, 'gh-state.json');
  const bin = join(root, 'bin');
  await mkdir(bin);
  const issue = (number, payload) => ({
    id: 'I_' + number, number, body: marked('job', payload), author: { login: 'muse' }, comments: [],
  });
  await writeJson(state, { 1: issue(1, { kind: 'illustration', request: 'ルウの基準画を作る' }) });
  await writeFile(join(bin, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(process.env.FAKE_GH_STATE));
if (args[0] === 'api' && args[1] === 'graphql' && args.includes('--paginate')) {
  const number = args.find(arg => arg.startsWith('issue=')).slice(6);
  const original = state[number];
  const page = nodes => ({ data: { repository: { issue: { ...original, comments: { nodes } } } } });
  console.log(JSON.stringify([page(original.comments.slice(0, 2)), page(original.comments.slice(2))]));
} else if (args[0] === 'issue' && args[1] === 'comment' && args.includes('--body-file')) {
  const { comments } = state[args[2]];
  comments.push({ id: 'receipt-' + comments.length, viewerDidAuthor: true, body: fs.readFileSync(0, 'utf8') });
  fs.writeFileSync(process.env.FAKE_GH_STATE, JSON.stringify(state));
} else process.exit(9);
`, { mode: 0o755 });
  const env = { ...process.env, PATH: bin + ':' + process.env.PATH, FAKE_GH_STATE: state };
  let matches = false;
  const server = createServer(async (request, response) => {
    try {
      const bytes = await readFile(join(root, 'preview', request.url));
      const types = { '.html': 'text/html', '.png': 'image/png', '.gif': 'image/gif' };
      response.writeHead(200, { 'Content-Type': types[extname(request.url)] }).end(matches ? bytes : '古い版');
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port + '/';
  const runIssue = (number, publish = true) => cli(root, [
    'process-issue', '--repo', 'example/art-studio', '--issue', String(number), '--preview-base-url', base,
    ...(publish ? ['--publish'] : []),
  ], { env });
  async function command(number, id, payload) {
    const all = await readJson(state);
    all[number].comments.push({ id, author: { login: 'muse' }, body: marked('command', payload) });
    await writeJson(state, all);
  }

  const planned = statusOf((await runIssue(1, false)).stdout);
  await assert.rejects(runIssue(1), /配信ファイルが対象版と一致しません/);
  assert.deepEqual((await readJson(state))[1].comments, []);
  matches = true;
  const still = statusOf((await runIssue(1)).stdout);
  assert.deepEqual(still, planned);
  assert.match((await runIssue(1)).stdout, /未処理の依頼はありません/);
  await command(1, 'adopt-base', { action: 'adopt', revision: 1 });
  assert.equal(statusOf((await runIssue(1)).stdout).status, 'adopted');

  const all = await readJson(state);
  all[2] = issue(2, {
    kind: 'animation', request: '右向き歩き', reference: { jobId: still.jobId, revision: 1 },
  });
  await writeJson(state, all);
  const original = statusOf((await runIssue(2)).stdout);
  assert.equal(original.revision, 1);
  assert.deepEqual(await readFile(join(root, 'jobs', original.jobId, 'v1/input/reference.png')),
    await readFile(join(root, 'jobs', still.jobId, 'v1/output/base.png')));
  await command(2, 'revise-walk', {
    action: 'revise', baseRevision: 1, request: 'テンポをゆっくりにして', change: 'テンポを遅く', keep: 'コマの絵',
  });
  const updated = statusOf((await runIssue(2)).stdout);
  assert.equal(updated.revision, 2);
  assert.equal(updated.baseRevision, 1);
  assert.match(updated.previewUrl, /\/v2\/index.html$/);
  await command(2, 'adopt-walk', { action: 'adopt', revision: 2 });
  assert.equal(statusOf((await runIssue(2)).stdout).status, 'adopted');
  await command(2, 'log-timing', {
    action: 'log-improvement', revision: 2, step: 'step4-export', symptom: '表示時間が確認しづらい', expected: 'コマ別の時間が分かる',
    countermeasure: '比較ページに表示時間を載せて再確認',
  });
  assert.equal(statusOf((await runIssue(2)).stdout).status, 'improvement');
  assert.match((await runIssue(2)).stdout, /未処理の依頼はありません/);
  assert.deepEqual(await readdir(join(root, 'jobs', original.jobId)), ['adopted.json', 'v1', 'v2']);
  assert.equal((await readJson(state))[2].comments.filter(comment => comment.viewerDidAuthor).length, 4);
  const log = await readFile(join(root, 'docs/improvement-log.md'), 'utf8');
  assert.match(log, /step4-export/);
  assert.match(log, /比較ページに表示時間を載せて再確認/);
});
