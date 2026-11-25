import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { previewDir } from './preview-builder.mjs';
import { isObject, isText, readJson, requireThat, validateRevision } from './schema.mjs';
import { adoptedReference, adoptRevision, listRevisions, logImprovement, readRevision, runLocal } from './workspace.mjs';

const markers = {
  job: '<!-- muse-2d-job -->',
  command: '<!-- muse-2d-command -->',
  status: '<!-- muse-2d-status -->',
};
const issueQuery = `
query($owner: String!, $name: String!, $issue: Int!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    issue(number: $issue) {
      id number body author { login }
      comments(first: 100, after: $endCursor) {
        nodes { id body author { login } authorAssociation viewerDidAuthor isMinimized }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}
`;

function gh(args, { input } = {}) {
  const output = spawnSync('gh', args, { input, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (output.error) throw output.error;
  requireThat(output.status === 0, output.stderr.trim() || 'gh の実行に失敗');
  return output.stdout.trim();
}

function jsonBlock(body, marker) {
  if (typeof body !== 'string') return null;
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex(line => line.trim() === marker);
  if (start < 0) return null;
  requireThat(lines[start + 1]?.trim() === '```json', marker + ' の直後に JSON ブロックが必要');
  const end = lines.findIndex((line, index) => index > start + 1 && line.trim() === '```');
  requireThat(end > start + 2, marker + ' の JSON ブロックが閉じられていない');
  const value = JSON.parse(lines.slice(start + 2, end).join('\n'));
  requireThat(isObject(value), marker + ' の JSON はオブジェクトが必要');
  return value;
}

function issueTarget(repo, issue) {
  requireThat(typeof repo === 'string' && /^[\w.-]+\/[\w.-]+$/.test(repo) && !repo.startsWith('-'), 'repo は owner/repo 形式が必要');
  return [String(validateRevision(issue)), '--repo', 'github.com/' + repo];
}

function readIssue(repo, issue) {
  const [owner, name] = repo.split('/');
  const pages = JSON.parse(gh(['api', 'graphql', '--hostname', 'github.com', '--paginate', '--slurp',
    '-f', 'query=' + issueQuery, '-f', 'owner=' + owner, '-f', 'name=' + name, '-F', 'issue=' + issue]));
  const issues = pages.map(page => page.data?.repository?.issue);
  requireThat(issues[0] && issues.every(item => item && item.id === issues[0].id), 'Issue が取得できません: ' + issue);
  return { ...issues[0], comments: issues.flatMap(item => item.comments.nodes) };
}

function jobIdFor(repo, issue) {
  const key = repo.toLowerCase();
  const name = key.split('/').at(-1).replace(/[^a-z0-9-]/g, '-').slice(0, 36);
  const suffix = createHash('sha256').update(key).digest('hex').slice(0, 10);
  return 'issue-' + issue + '-' + name + '-' + suffix;
}

function publishedEvents(issue) {
  const done = new Set();
  for (const comment of issue.comments ?? []) {
    if (!comment.viewerDidAuthor) continue;
    try {
      const status = jsonBlock(comment.body, markers.status);
      if (isText(status?.eventId)) done.add(status.eventId);
    } catch {
      // Only valid handoff receipts are used for deduplication.
    }
  }
  return done;
}

function nextEvent(issue) {
  const ignored = publishedEvents(issue);
  const initialId = 'issue:' + issue.id;
  if (!ignored.has(initialId)) {
    const job = jsonBlock(issue.body, markers.job);
    requireThat(job, 'Issue 本文に ' + markers.job + ' が必要');
    return { eventId: initialId, action: 'create', payload: job };
  }
  const commands = issue.comments ?? [];
  for (const comment of commands) {
    const trusted = comment.author?.login && (comment.author.login === issue.author?.login ||
      ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(comment.authorAssociation));
    if (!trusted || !isText(comment.id) || comment.isMinimized) continue;
    const eventId = 'comment:' + comment.id;
    if (ignored.has(eventId)) continue;
    const payload = jsonBlock(comment.body, markers.command);
    if (!payload) continue;
    requireThat(['revise', 'adopt', 'log-improvement'].includes(payload.action), '不正な Muse コマンド');
    return { eventId, action: payload.action, payload };
  }
  return null;
}

function previewUrl(base, jobId, revision) {
  if (!base) return null;
  const url = new URL(base);
  requireThat(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash,
    'preview-base-url はクエリや認証情報を含まない HTTP(S) URL が必要');
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return new URL(jobId + '/v' + revision + '/index.html', url).href;
}

async function verifyPublished(root, meta) {
  requireThat(meta.previewUrl, '確認待ちを投稿する前に --preview-base-url と配信済みプレビューが必要');
  const directory = previewDir(root, meta.jobId, meta.revision);
  const files = await readdir(directory);
  // Confirm the deployed page and each image match the exact local revision.
  await Promise.all(files.map(async file => {
    const url = new URL(file, meta.previewUrl);
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
    const local = await readFile(join(directory, file));
    const contentType = { html: 'text/html', png: 'image/png', gif: 'image/gif' }[file.split('.').at(-1)];
    const matches = response.ok && response.headers.get('content-type')?.split(';')[0]?.trim() === contentType &&
      local.equals(Buffer.from(await response.arrayBuffer()));
    requireThat(matches, '配信ファイルが対象版と一致しません: ' + url.href);
  }));
}

function oneLine(text) {
  return text.replace(/\s+/g, ' ').trim();
}

export function formatStatus(meta) {
  const visible = [
    '- 対象版　' + meta.target,
    '- 状態　' + ({ review: '確認待ち', adopted: '採用済み', blocked: '停止・要確認', improvement: '改善記録済み' })[meta.status],
    ...(meta.previewUrl ? ['- 実物を見る　' + meta.previewUrl] : []),
    '- 今回のポイント・検品　' + oneLine(meta.point),
    '- 見てほしい点　' + oneLine(meta.lookFor),
    ...(meta.reply ? ['- 返し方　' + meta.reply] : []),
  ];
  const encoded = JSON.stringify(meta, null, 2).replaceAll('<', '\\u003c');
  const markdown = visible.map(line => line.replace(/[<>]/g, char => char === '<' ? '&lt;' : '&gt;'));
  return [markers.status, '```json', encoded, '```', '', ...markdown].join('\n') + '\n';
}

async function revisionStatus(outcome, eventId, base) {
  const { job, result } = outcome;
  const status = result.status;
  const passed = result.checks.filter(check => check.status === 'pass').length;
  const failures = result.checks.filter(check => check.status === 'fail');
  let title = job.kind === 'animation' ? 'ルウ／アニメーション' : 'ルウ／基準画';
  if (status !== 'blocked' && job.kind === 'animation') {
    const file = result.artifacts.find(path => path.endsWith('.json'));
    const metadata = await readJson(join(outcome.jobDir, file));
    title = metadata.motion === 'idle' ? 'ルウ／待機・まばたき' : 'ルウ／右向き歩き';
  }
  let lookFor = job.kind === 'animation' ? 'ループと足の接地を確認してください。' : '顔、服、向きの印象を確認してください。';
  if (status === 'blocked') lookFor = '停止した検品や制作条件を確認してください。';
  else if (job.step === 'step3-frames') lookFor = '指定したコマと残す部分を前版と見比べてください。';
  else if (job.baseRevision) lookFor = '前版と比べてテンポと動きが意図どおりか確認してください。';
  return {
    eventId, jobId: job.jobId, revision: job.revision, baseRevision: job.baseRevision, status,
    target: title + ' v' + job.revision,
    previewUrl: status === 'review' ? previewUrl(base, job.jobId, job.revision) : null,
    checks: { pass: passed, fail: failures.length, skipped: result.checks.length - passed - failures.length },
    point: (job.change || job.request) + '。検品 ' + passed + ' 件合格' +
      (failures.length ? '。' + failures.map(check => check.name + ' ' + check.detail).join(' / ') : ''),
    lookFor,
    reply: status === 'review' ? '修正点（変える点・残す点）か、「この v' + job.revision + ' を採用」と返してください。' : null,
  };
}

function inferStep(kind, change) {
  if (kind !== 'animation') return 'step1-base';
  if (/袖|ハイライト|小物|コマ/.test(change)) return 'step3-frames';
  if (/キーポーズ|重心|足踏み/.test(change)) return 'step2-keypose';
  return 'step4-export';
}

async function runEvent({ root, event, issue, repo, base }) {
  const id = jobIdFor(repo, issue.number);
  const { eventId, action, payload } = event;
  if (action === 'adopt') {
    const entry = await adoptRevision(root, id, payload.revision);
    return adoptionStatus(id, entry, eventId);
  }
  if (action === 'log-improvement') {
    const { step, revision, symptom, expected, cause, countermeasure } = payload;
    await logImprovement(root, { step, revision, symptom, expected, cause, action: countermeasure, jobId: id, source: eventId });
    return {
      eventId, jobId: id, revision, status: 'improvement',
      target: id + ' v' + revision, previewUrl: null, checks: null,
      point: step + ' の改善記録を保存しました。', lookFor: expected || symptom, reply: null,
    };
  }
  const versions = await listRevisions(root, id);
  let revision;
  for (const number of versions) {
    if ((await readRevision(root, id, number)).job.source === eventId) {
      revision = number;
      break;
    }
  }
  const creating = action === 'create';
  let kind = payload.kind;
  if (!creating) {
    const base = await readRevision(root, id, payload.baseRevision);
    kind = base.job.kind;
  }
  const rawJob = {
    jobId: id, revision: revision ?? (creating ? 1 : (versions.at(-1) ?? 0) + 1),
    baseRevision: creating ? null : payload.baseRevision, kind,
    request: payload.request, change: payload.change, keep: payload.keep,
    step: payload.step ?? inferStep(kind, payload.change || payload.request || ''), inputs: {}, source: eventId,
  };
  const sourceFiles = new Map();
  if (creating && payload.reference !== undefined) {
    const path = 'input/reference.png';
    rawJob.inputs.reference = path;
    sourceFiles.set(path, await adoptedReference(root, payload.reference));
  }
  const outcome = await runLocal({ root, rawJob, sourceFiles });
  if (outcome.result.status === 'adopted') {
    return adoptionStatus(id, await adoptRevision(root, id, outcome.job.revision), eventId);
  }
  const { jobDir } = await readRevision(root, id, outcome.job.revision);
  return revisionStatus({ ...outcome, jobDir }, eventId, base);
}

function adoptionStatus(jobId, entry, eventId) {
  return {
    eventId, jobId, revision: entry.revision, status: 'adopted', target: jobId + ' v' + entry.revision, previewUrl: null,
    checks: null,
    point: entry.spriteSheet ? '採用を確定し、スプライトシート PNG とフレーム JSON を記録しました。' : '基準画 PNG の採用を確定しました。',
    lookFor: '採用版 v' + entry.revision, reply: null,
  };
}

export async function postAdoption({ root, repo, issue, id, revision }) {
  const target = issueTarget(repo, issue);
  const data = readIssue(repo, issue);
  requireThat(jobIdFor(repo, data.number) === id, 'Issue と job-id が一致しません');
  requireThat((await readRevision(root, id, revision)).job.source, '対象版に Issue の依頼元がありません');
  const entry = await adoptRevision(root, id, revision);
  const key = 'adopt:' + data.id + ':v' + revision;
  if (!publishedEvents(data).has(key)) gh(['issue', 'comment', ...target, '--body-file', '-'], { input: formatStatus(adoptionStatus(id, entry, key)) });
  return entry;
}

export async function processIssue({ root, repo, issue, issueFile, dryRun, publish, base }) {
  const target = issueTarget(repo, issue);
  requireThat(!issueFile || dryRun, '--issue-file は --dry-run 専用');
  requireThat(!(dryRun && publish), '--dry-run と --publish の併用はできません');
  const data = issueFile ? await readJson(issueFile) : readIssue(repo, issue);
  requireThat(data.number === issue && isText(data.id), '不正な Issue JSON または番号が不一致');
  const event = nextEvent(data);
  if (!event) return null;
  const workingRoot = dryRun ? await mkdtemp(join(tmpdir(), 'muse-2d-dry-')) : root;
  try {
    if (dryRun) {
      await mkdir(join(workingRoot, 'docs'));
      for (const path of ['jobs', 'preview', 'docs/improvement-log.md']) {
        await cp(join(root, path), join(workingRoot, path), { recursive: true }).catch(error => {
          if (error.code !== 'ENOENT') throw error;
        });
      }
    }
    const meta = await runEvent({ root: workingRoot, event, issue: data, repo, base });
    const comment = formatStatus(meta);
    if (publish) {
      if (meta.status === 'review') await verifyPublished(root, meta);
      const latest = readIssue(repo, issue);
      if (!publishedEvents(latest).has(event.eventId)) {
        requireThat(latest.id === data.id && isDeepStrictEqual(nextEvent(latest), event),
          '投稿前に Issue の依頼が変更されました');
        gh(['issue', 'comment', ...target, '--body-file', '-'], { input: comment });
      }
    }
    return comment;
  } finally {
    if (dryRun) await rm(workingRoot, { recursive: true, force: true });
  }
}
