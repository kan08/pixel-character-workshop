import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { artifactFile, pathsForFrames } from './checks.mjs';
import { readJson, requireThat, writeAtomic } from './schema.mjs';

const css = `
  :root {
    color-scheme: light dark; --bg:#f7f5fb; --card:#fff; --text:#252037; --muted:#615973;
    --line:#e1dbeb; --stage:#eeebf5; --accent:#534294; --pass-bg:#dcf2e7; --pass:#174c35;
    --fail-bg:#f9e3e5; --fail:#802e3c;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg:#131209; --card:#181818; --text:#f2eef9; --muted:#c7bdd7; --line:#414047;
      --stage:#272727; --accent:#d0bfff; --pass-bg:#183d2e; --pass:#b7f3ce; --fail-bg:#48262e; --fail:#fed0d6;
    }
  }
  * { box-sizing:border-box }
  body { margin:0; background:var(--bg); color:var(--text); font:1rem/1.5 Geist,system-ui,sans-serif }
  main { width:min(100%,48rem); margin-inline:auto; padding:24px 16px 48px; overflow-wrap:anywhere }
  a { color:var(--accent); text-underline-offset:3px }
  h1,h2,h3 { margin:0; text-wrap:balance }
  h1 { font-size:1.875rem; line-height:2.25rem }
  h2 { font-size:1.25rem; line-height:1.75rem; margin-bottom:12px }
  h3 { font-size:1rem }
  p { margin:0; text-wrap:pretty }
  header p { color:var(--muted); margin-top:4px }
  section, header { margin-top:24px }
  .comparison { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px }
  .panel, .reply { background:var(--card); border:1px solid var(--line); border-radius:16px; padding:8px }
  .panel h3 { margin:4px 4px 8px }
  .panel:only-child { grid-column:1/-1 }
  .stage { min-width:0; display:grid; place-items:center; border-radius:8px; background:var(--stage); }
  .stage img { display:block; width:min(100%,256px); height:auto; image-rendering:pixelated }
  .native { display:flex; align-items:center; gap:8px; margin:8px 4px 4px; color:var(--muted); font-size:.875rem; line-height:1.25rem }
  .native img { image-rendering:pixelated; flex:none; max-width:100%; height:auto }
  .frames,.checks,.index { list-style:none; margin:0; padding:0 }
  .frames { display:grid; grid-template-columns:repeat(auto-fit,minmax(64px,1fr)); gap:8px }
  .frames li { min-width:0; padding:8px 4px; text-align:center; border:1px solid var(--line); border-radius:8px }
  .frames img { display:block; margin:0 auto 4px; width:48px; height:auto; image-rendering:pixelated }
  .frames span,.checks li { font-size:.875rem; line-height:1.25rem }
  .checks li,.index li { padding-block:8px; border-bottom:1px solid var(--line) }
  .checks p { color:var(--muted); margin:4px 0 0 }
  .badge { display:inline-block; border-radius:999px; padding:2px 8px; margin-right:8px }
  .pass { color:var(--pass); background:var(--pass-bg) }
  .fail { color:var(--fail); background:var(--fail-bg) }
  .skipped { color:var(--muted); background:var(--stage) }
  .reply { padding:16px }
  .reply p + p { margin-top:8px }
  details summary { cursor:pointer }
`;

function escape(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function page(title, body) {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escape(title)}</title>
<style>${css}</style>
</head>
<body><main>${body}</main></body>
</html>
`;
}

const checkLabels = {
  artifacts: '成果物', png: 'PNG', 'png-preview': 'PNG プレビュー', 'sheet-json': 'シートと JSON',
  'gif-preview': 'GIF プレビュー', 'gif-decode': 'GIF 読み戻し', 'frame-count': 'コマ数',
  'gif-timing': '表示時間・ループ', 'gif-size': 'GIF 寸法',
};

function badge(status) {
  return `<span class="badge ${status}">${{ pass: '合格', fail: '不合格', skipped: '未検査' }[status]}</span>`;
}

function panel(revision, label, suffix, format, width, height) {
  const native = suffix + 'native.' + format;
  return `<article class="panel" aria-label="${label} v${revision}">
  <h3>${label} v${revision}</h3>
  <div class="stage"><img src="${suffix}preview.${format}" alt="${label} v${revision} 拡大表示"></div>
  <div class="native"><img src="${native}" width="${width}" height="${height}" alt="">
  <a href="${native}">原寸 ${width} × ${height}</a></div>
</article>`;
}

function dimensions(data, format) {
  return format === 'gif'
    ? { width: data.readUInt16LE(6), height: data.readUInt16LE(8) }
    : { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

export function previewDir(root, jobId, revision) {
  return join(root, 'preview', jobId, 'v' + revision);
}

export async function buildPreview({ root, jobDir, job, result, compareBase }) {
  const directory = previewDir(root, job.jobId, job.revision);
  await mkdir(join(root, 'preview', job.jobId), { recursive: true });
  const staging = await mkdtemp(directory + '-');
  const copy = async (from, file) => copyFile(await artifactFile(jobDir, from), join(staging, file));
  try {
    const format = job.kind === 'animation' ? 'gif' : 'png';
    const candidates = [];
    for (const path of result.artifacts.filter(path => path.endsWith('.' + format))) {
      const data = await readFile(await artifactFile(jobDir, path));
      candidates.push({ path, ...dimensions(data, format) });
    }
    candidates.sort((a, b) => a.width * a.height - b.width * b.height);
    const { path, width, height } = candidates[0];
    await copy(path, 'native.' + format);
    await copy(result.preview, 'preview.' + format);
    let comparison = panel(job.revision, compareBase ? '今回' : '拡大と原寸', '', format, width, height);
    if (compareBase) {
      const previous = previewDir(root, job.jobId, job.baseRevision);
      await copyFile(join(previous, 'preview.' + format), join(staging, 'previous-preview.' + format));
      const previousPath = join(previous, 'native.' + format);
      await copyFile(previousPath, join(staging, 'previous-native.' + format));
      const prior = dimensions(await readFile(previousPath), format);
      comparison = panel(job.baseRevision, '前版', 'previous-', format, prior.width, prior.height) + comparison;
    }

    let frames = '';
    let title = job.kind === 'pixel' ? 'ドット絵' : '基準画';
    if (format === 'gif') {
      const json = result.artifacts.find(path => path.endsWith('.json'));
      const metadata = await readJson(await artifactFile(jobDir, json));
      const paths = pathsForFrames(json, metadata);
      title = { walk: '右向き歩き', idle: '待機・まばたき' }[metadata.motion] ?? 'アニメーション';
      const items = [];
      for (const [index, path] of paths.frames.entries()) {
        const name = 'frame-' + (index + 1) + '.png';
        await copy(path, name);
        items.push(`<li><img src="${name}" alt="${index + 1} コマ目"><span>${index + 1} · ${metadata.frames[index].ms} ms</span></li>`);
      }
      await copy(paths.sheet, 'sheet.png');
      frames = `<section><h2>コマと表示時間</h2><ol class="frames">${items.join('')}</ol>
      <p><a href="sheet.png">スプライトシート PNG</a></p></section>`;
    }
    const checks = result.checks.map(({ name, status, detail }) => {
      const [id, file] = name.split(': ');
      return `<li>${badge(status)}${escape(checkLabels[id] ?? id)}${file ? ' · ' + escape(file.replace(/^output\//, '')) : ''}
        ${detail ? '<p>' + escape(detail) + '</p>' : ''}</li>`;
    });
    const titleWithVersion = title + ' v' + job.revision;
    const correction = format === 'gif' ? 'テンポをもう少し遅くして' : 'この v' + job.revision + ' を採用。次は右向き歩きを作って';
    const baseLink = compareBase ? `<p><a href="../v${job.baseRevision}/index.html">前版 v${job.baseRevision} の検品とコマを見る</a></p>` : '';
    await writeFile(join(staging, 'index.html'), page(titleWithVersion, `
      <nav><a href="../../index.html">プレビュー一覧</a></nav>
      <header><h1>${titleWithVersion}</h1><p>${escape(job.jobId)}</p></header>
      <section aria-label="成果物"><div class="comparison">${comparison}</div>${baseLink}</section>
      ${frames}
      <section><details><summary>${badge('pass')}自動検品 ${checks.length} 件</summary><ul class="checks">${checks.join('')}</ul></details></section>
      <section class="reply"><h2>Muse に返す</h2><p>「この v${job.revision} を採用」</p><p>「${correction}」</p></section>
    `));
    // A running job can resume after a crash between preview and result writes.
    await rm(directory, { recursive: true, force: true });
    await rename(staging, directory);
    return { directory, title };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function buildPreviewIndex(root) {
  const directory = join(root, 'preview');
  await mkdir(directory, { recursive: true });
  const ids = (await readdir(directory, { withFileTypes: true })).filter(entry => entry.isDirectory());
  const jobs = [];
  for (const { name: id } of ids.sort((a, b) => a.name.localeCompare(b.name))) {
    const versions = (await readdir(join(directory, id), { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && /^v[1-9]\d*$/.test(entry.name))
      .sort((a, b) => Number(b.name.slice(1)) - Number(a.name.slice(1)));
    for (const { name } of versions) {
      const result = await readJson(join(root, 'jobs', id, name, 'result.json')).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!['review', 'adopted'].includes(result?.status)) continue;
      requireThat(/^[a-z0-9][a-z0-9-]*$/.test(id), '不正なプレビュー ID');
      jobs.push(`<li><a href="${id}/${name}/index.html">${id} ${name}</a></li>`);
    }
  }
  await writeAtomic(join(directory, 'index.html'), page('プレビュー一覧', `
    <h1>プレビュー一覧</h1>
    ${jobs.length ? '<ul class="index">' + jobs.join('') + '</ul>' : '<p>確認できる版がまだありません。</p>'}
  `));
}
