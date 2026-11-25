import { copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, posix, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { artifactFile, inspectArtifacts, pathsForFrames } from './checks.mjs';
import { runEngine } from './engines/sample-walk-engine.mjs';
import { buildPreview, buildPreviewIndex, previewDir } from './preview-builder.mjs';
import {
  gatePasses, isText, readJson, readOptionalJson, relativePath, requireThat, revisionDir, steps,
  transition, validateJob, validateJobId, validateResult, validateRevision, writeAtomic, writeJson,
} from './schema.mjs';

export async function withWorkspaceLock(root, operation) {
  await mkdir(root, { recursive: true });
  const path = join(root, '.pipeline.lock');
  const lock = await open(path, 'wx').catch(error => {
    if (error.code === 'EEXIST') throw new Error('別のランナーが作業中です: ' + path);
    throw error;
  });
  try {
    await lock.writeFile(String(process.pid) + '\n');
    return await operation();
  } finally {
    await lock.close();
    await rm(path, { force: true });
  }
}

export async function readRevision(root, id, revision) {
  const jobDir = revisionDir(root, id, revision);
  const job = validateJob(await readJson(join(jobDir, 'job.json')));
  requireThat(job.jobId === id && job.revision === revision, 'job.json が版フォルダと一致しない');
  const result = validateResult(await readJson(join(jobDir, 'result.json')), job);
  return { jobDir, job, result };
}

export async function listRevisions(root, jobId) {
  const versions = await readdir(join(root, 'jobs', validateJobId(jobId)), { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  return versions.filter(entry => entry.isDirectory() && /^v[1-9]\d*$/.test(entry.name))
    .map(entry => Number(entry.name.slice(1))).sort((a, b) => a - b);
}

async function copyInput(source, destination) {
  requireThat((await lstat(source)).isFile(), '入力は通常ファイルを指定してください: ' + source);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

async function localInput(sourceDir, path) {
  requireThat(sourceDir, '入力ファイルの場所が不明: ' + path);
  const realSource = await realpath(sourceDir);
  const file = join(realSource, path);
  requireThat((await realpath(file)).startsWith(realSource + sep), '入力ファイルが依頼フォルダの外にあります');
  return file;
}

async function prepareInputs(root, job, sourceFiles) {
  const files = new Map(sourceFiles);
  if (job.baseRevision === null) return { files, compareBase: false };
  const base = await readRevision(root, job.jobId, job.baseRevision);
  requireThat(['review', 'adopted', 'blocked'].includes(base.result.status) && job.kind === base.job.kind,
    '終了した同じ kind の版から修正してください');
  if (!job.inputs.reference && base.job.inputs.reference) {
    job.inputs.reference = 'input/base-reference.png';
    files.set(job.inputs.reference, join(base.jobDir, base.job.inputs.reference));
  }
  if (base.result.status === 'blocked') return { files, compareBase: false };
  if (!job.inputs.previous) {
    job.inputs.previous = 'input/prior-preview' + (job.kind === 'animation' ? '.gif' : '.png');
    files.set(job.inputs.previous, await artifactFile(base.jobDir, base.result.preview));
  }
  if (job.kind === 'animation') {
    const snapshot = 'input/previous/frames.json';
    requireThat(job.inputs.previousMetadata === undefined || job.inputs.previousMetadata === snapshot,
      'previousMetadata はランナーが前版から設定');
    const metadataPath = base.result.artifacts.find(path => path.endsWith('.json'));
    const metadataFile = await artifactFile(base.jobDir, metadataPath);
    const paths = pathsForFrames(metadataPath, await readJson(metadataFile));
    job.inputs.previousMetadata = snapshot;
    files.set(job.inputs.previousMetadata, metadataFile);
    for (const path of [...paths.frames, paths.sheet]) {
      const target = posix.join(dirname(job.inputs.previousMetadata), posix.relative(dirname(metadataPath), path));
      files.set(relativePath(target, 'input'), await artifactFile(base.jobDir, path));
    }
  }
  return { files, compareBase: true };
}

async function reserveRevision({ root, jobDir, job, sourceDir, files, versions }) {
  if (versions.includes(job.revision)) {
    const current = await readRevision(root, job.jobId, job.revision);
    requireThat(isDeepStrictEqual(current.job, job), '同じ版に別の依頼が保存済みです。新しい版を指定してください');
    return current.result;
  }
  requireThat(job.revision === (versions.at(-1) ?? 0) + 1, 'revision は保存済みの最新版に続く番号を指定');
  await mkdir(dirname(jobDir), { recursive: true });
  const staging = await mkdtemp(jobDir + '-');
  const result = { jobId: job.jobId, revision: job.revision, artifacts: [], preview: null, checks: [], status: 'accepted' };
  try {
    await mkdir(join(staging, 'input'));
    await mkdir(join(staging, 'output'));
    const inputs = new Set([...Object.values(job.inputs), ...files.keys()]);
    for (const path of inputs) {
      await copyInput(files.get(path) ?? await localInput(sourceDir, path), join(staging, path));
    }
    await writeJson(join(staging, 'job.json'), job);
    await writeJson(join(staging, 'result.json'), result);
    await rename(staging, jobDir);
  } finally {
    await rm(staging, { force: true, recursive: true });
  }
  return result;
}

export async function runLocal({ root, rawJob, sourceDir, sourceFiles = new Map(), engine = runEngine }) {
  const job = validateJob(rawJob);
  const jobDir = revisionDir(root, job.jobId, job.revision);
  const resultPath = join(jobDir, 'result.json');
  const versions = await listRevisions(root, job.jobId);
  const { files, compareBase } = await prepareInputs(root, job, sourceFiles);
  let result = await reserveRevision({ root, jobDir, job, sourceDir, files, versions });
  const directory = previewDir(root, job.jobId, job.revision);
  if (['review', 'adopted'].includes(result.status)) {
    await buildPreviewIndex(root);
    return { job, result, directory, repeat: true };
  }
  if (result.status === 'blocked') return { job, result, directory: null, repeat: true };
  if (result.status === 'accepted') {
    result = transition(job, result, 'running');
    await writeJson(resultPath, result);
  }
  const outputDir = join(jobDir, 'output');
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir);
  let stage = 'engine';
  let candidate = result;
  try {
    const output = await engine({ jobDir, job: structuredClone(job) });
    candidate = validateResult({ ...output, checks: [], status: 'running' }, job);
    stage = 'checks';
    candidate.checks = await inspectArtifacts({ jobDir, job, result: candidate });
    if (gatePasses(candidate.checks)) {
      stage = 'preview';
      await buildPreview({ root, jobDir, job, result: candidate, compareBase });
      result = transition(job, candidate, 'review');
    } else {
      result = transition(job, candidate, 'blocked');
    }
  } catch (error) {
    result = transition(job, candidate, 'blocked', { checks: [
      ...candidate.checks, { name: stage, status: 'fail', required: true, detail: error.message },
    ] });
  }
  await writeJson(resultPath, result);
  if (result.status === 'review') await buildPreviewIndex(root);
  return { job, result, directory: result.status === 'review' ? directory : null, repeat: false };
}

export async function adoptRevision(root, id, revision) {
  const { jobDir, job, result } = await readRevision(root, id, revision);
  requireThat(['review', 'adopted'].includes(result.status), '採用には検品済みの版が必要');
  const file = join(root, 'jobs', id, 'adopted.json');
  const ledger = await readOptionalJson(file) ?? { jobId: id, revision: null, history: [] };
  const prior = ledger.history.find(entry => entry.revision === revision);
  if (prior) return { ...prior, repeat: true };
  const checks = await inspectArtifacts({ jobDir, job, result });
  requireThat(gatePasses(checks), '採用前の再検品に失敗: ' + checks.filter(check => check.status === 'fail')
    .map(check => check.detail).join(' / '));
  const entry = { revision, adoptedAt: new Date().toISOString() };
  const versionPath = 'jobs/' + id + '/v' + revision + '/';
  if (job.kind === 'animation') {
    const metadata = result.artifacts.find(path => path.endsWith('.json'));
    const paths = pathsForFrames(metadata, await readJson(await artifactFile(jobDir, metadata)));
    entry.spriteSheet = versionPath + paths.sheet;
    entry.frameJson = versionPath + metadata;
  } else {
    const pngs = result.artifacts.filter(path => path.endsWith('.png'));
    entry.reference = versionPath + (pngs.find(path => path !== result.preview) ?? result.preview);
  }
  if (result.status === 'review') await writeJson(join(jobDir, 'result.json'), transition(job, result, 'adopted', { checks }));
  await writeJson(file, { ...ledger, revision, ...entry, history: [...ledger.history, entry] });
  return entry;
}

export async function adoptedReference(root, reference) {
  validateJobId(reference?.jobId);
  validateRevision(reference?.revision);
  const { jobDir, job, result } = await readRevision(root, reference.jobId, reference.revision);
  const ledger = await readJson(join(root, 'jobs', job.jobId, 'adopted.json'));
  const entry = ledger.history.find(item => item.revision === job.revision);
  requireThat(result.status === 'adopted' && entry?.reference, '採用済みの基準画を指定してください');
  const path = posix.relative('jobs/' + job.jobId + '/v' + job.revision, entry.reference);
  requireThat(result.artifacts.includes(path) && basename(path).endsWith('.png'), '採用済みの PNG を指定してください');
  return artifactFile(jobDir, path);
}

function markdownText(value) {
  return value.replace(/[&<>]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char]);
}

export async function logImprovement(root, details) {
  const { step, jobId, revision, symptom, cause, action, expected, source } = details;
  requireThat(steps.includes(step), '不正な工程タグ');
  requireThat(isText(symptom), '症状の記録には symptom が必要');
  for (const text of [cause, action, expected]) requireThat(text === undefined || typeof text === 'string', '改善記録の値は文字列が必要');
  const { job, result } = await readRevision(root, jobId, revision);
  const file = join(root, 'docs', 'improvement-log.md');
  await mkdir(dirname(file), { recursive: true });
  const previous = await readFile(file, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '# 改善記録\n';
    throw error;
  });
  const key = source ? '<!-- muse-2d-improvement ' + source + ' -->' : '';
  if (key && previous.split('\n').includes(key)) return { file, repeat: true };
  const path = 'jobs/' + jobId + '/v' + revision;
  const findings = result.checks.filter(check => check.status === 'fail').map(check => check.name + ' — ' + check.detail);
  const lines = [
    '## ' + new Date().toISOString().slice(0, 10) + ' · `' + step + '` · ' + jobId + ' v' + revision,
    key, '- 再現情報 [job.json](../' + path + '/job.json) と [result.json](../' + path + '/result.json)',
    '- 症状\n' + quoted(symptom),
    '- 依頼原文\n' + quoted(job.request),
    ...(job.baseRevision ? ['- 比較元 v' + job.baseRevision] : []),
    ...(findings.length ? ['- 検品で止まった箇所\n' + quoted(findings.join('\n'))] : []),
    ...(expected ? ['- 期待する状態\n' + quoted(expected)] : []),
    ...(cause ? ['- 原因\n' + quoted(cause)] : []),
    ...(action ? ['- 対策・再検証\n' + quoted(action)] : []),
  ];
  await writeAtomic(file, previous.trimEnd() + '\n\n' + lines.filter(Boolean).join('\n') + '\n');
  return { file, repeat: false };
}

function quoted(value) {
  return markdownText(value).split(/\r?\n/).map(line => '  > ' + line).join('\n');
}
