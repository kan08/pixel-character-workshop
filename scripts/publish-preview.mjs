#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const previewRoot = join(root, 'preview');
const branch = 'gh-pages';

function run(cmd, args, cwd = root) {
  const res = spawnSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed:\n${res.stderr || res.stdout}`);
  }
  return res.stdout.trim();
}

async function main() {
  const entries = await readdir(previewRoot).catch(() => []);
  if (entries.length === 0) {
    throw new Error('preview/ が空です。先に npm run pipeline でプレビューを生成してください。');
  }

  const stage = await mkdtemp(join(tmpdir(), 'pixel-preview-pages-'));
  try {
    run('git', ['init', '-b', branch], stage);
    const userName = run('git', ['config', 'user.name'], root);
    const userEmail = run('git', ['config', 'user.email'], root);
    const remoteUrl = run('git', ['remote', 'get-url', 'origin'], root);
    run('git', ['config', 'user.name', userName], stage);
    run('git', ['config', 'user.email', userEmail], stage);
    run('git', ['remote', 'add', 'origin', remoteUrl], stage);

    for (const entry of entries) {
      await cp(join(previewRoot, entry), join(stage, entry), { recursive: true });
    }
    await writeFile(join(stage, '.nojekyll'), '');

    run('git', ['add', '-A'], stage);
    run('git', ['commit', '-m', 'chore(preview): publish static previews'], stage);
    run('git', ['push', '--force', 'origin', branch], stage);
    console.log(`Published preview/ to origin/${branch} (${entries.length} entries).`);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
