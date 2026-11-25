import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';

export const steps = ['step1-base', 'step2-keypose', 'step3-frames', 'step4-export', 'step5-preview'];
const kinds = ['illustration', 'pixel', 'animation'];
const transitions = {
  accepted: ['running', 'blocked'],
  running: ['review', 'blocked'],
  review: ['adopted', 'blocked'],
  adopted: [],
  blocked: [],
};

export function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}

export function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isText(value) {
  return typeof value === 'string' && Boolean(value.trim());
}

export function validateJobId(jobId) {
  requireThat(typeof jobId === 'string' && /^[a-z0-9][a-z0-9-]{0,79}$/.test(jobId), '不正な jobId');
  return jobId;
}

export function validateRevision(revision) {
  requireThat(Number.isSafeInteger(revision) && revision > 0, 'revision は正の整数が必要');
  return revision;
}

export function relativePath(value, parent) {
  requireThat(
    typeof value === 'string' && value.startsWith(parent + '/') && posix.normalize(value) === value &&
      value.split('/').every(part => /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(part)),
    parent + '/ 内の相対パスが必要',
  );
  return value;
}

export function revisionDir(root, jobId, revision) {
  return join(root, 'jobs', validateJobId(jobId), 'v' + validateRevision(revision));
}

export function validateJob(raw) {
  requireThat(isObject(raw), 'job.json はオブジェクトが必要');
  const { jobId, revision, kind, request, change = '', keep = '', inputs = {}, source } = raw;
  const baseRevision = raw.baseRevision === undefined ? null : raw.baseRevision;
  const step = raw.step ?? (kind === 'animation' ? 'step4-export' : 'step1-base');
  validateJobId(jobId);
  validateRevision(revision);
  requireThat(revision === 1 ? baseRevision === null : Number.isSafeInteger(baseRevision) &&
    baseRevision > 0 && baseRevision < revision, 'baseRevision は初版で null、修正版では存在する前版を指定');
  requireThat(kinds.includes(kind), '不正な kind');
  requireThat(steps.includes(step), '不正な step');
  requireThat(isText(request), 'request が必要');
  requireThat(typeof change === 'string' && typeof keep === 'string', 'change と keep は文字列が必要');
  requireThat(isObject(inputs), 'inputs はオブジェクトが必要');
  for (const path of Object.values(inputs)) relativePath(path, 'input');
  requireThat(source === undefined || isText(source), '不正な依頼元');
  return { jobId, revision, baseRevision, kind, step, request, change, keep, inputs, ...(source && { source }) };
}

export function validateResult(result, job) {
  requireThat(isObject(result) && result.jobId === job.jobId && result.revision === job.revision,
    '結果の jobId / revision が依頼と一致しない');
  requireThat(Object.hasOwn(transitions, result.status), '不正な status');
  const { artifacts, preview, checks, status } = result;
  requireThat(Array.isArray(artifacts) && new Set(artifacts).size === artifacts.length, 'artifacts は重複のない配列が必要');
  for (const path of artifacts) relativePath(path, 'output');
  requireThat(preview === null || artifacts.includes(preview), 'preview は artifacts 内の画像を指定');
  requireThat(Array.isArray(checks) && checks.every(check => isObject(check) && isText(check.name) &&
    ['pass', 'fail', 'skipped'].includes(check.status) &&
    (check.required === undefined || typeof check.required === 'boolean') &&
    (check.detail === undefined || typeof check.detail === 'string')), '不正な checks');
  if (status === 'review' || status === 'adopted') {
    requireThat(preview && gatePasses(checks), '必須検品を通過したプレビューが必要');
  }
  return result;
}

export function gatePasses(checks) {
  const required = checks.filter(check => check.required !== false);
  return required.length > 0 && required.every(check => check.status === 'pass');
}

export function transition(job, result, status, patch = {}) {
  requireThat(transitions[result.status]?.includes(status), result.status + ' → ' + status + ' は許可されていない');
  return validateResult({ ...result, ...patch, status }, job);
}

export async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

export async function readOptionalJson(file) {
  try {
    return await readJson(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function writeAtomic(file, body) {
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, body);
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

export function writeJson(file, value) {
  return writeAtomic(file, JSON.stringify(value, null, 2) + '\n');
}
