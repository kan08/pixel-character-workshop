import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { processIssue, postAdoption } from './issue-bridge.mjs';
import { readJson, requireThat, validateRevision } from './schema.mjs';
import { adoptRevision, logImprovement, runLocal, withWorkspaceLock } from './workspace.mjs';

const help = `使い方  npm run pipeline -- <command> [options]

run-local --job <job.json>
run-local --job-id <id> --kind <illustration|pixel|animation> --request <text> [--reference <png>]
          [--rev <N> --base-rev <N> --step <tag> --change <text> --keep <text>]
process-issue --repo <owner/repo> --issue <N> [--preview-base-url <url>] [--publish]
              [--dry-run [--issue-file <issue.json>]]
adopt --job-id <id> --rev <N> [--repo <owner/repo> --issue <N>]
log-improvement --step <tag> --job-id <id> --rev <N> --symptom <text>
                [--cause <text>] [--action <text>] [--expected <text>]

全コマンドで --root <dir> を指定すると、そのフォルダの jobs/、preview/、docs/ を使用します。
`;

const argumentsFor = {
  'run-local': ['job', 'job-id', 'kind', 'request', 'rev', 'base-rev', 'step', 'change', 'keep', 'reference'],
  'process-issue': ['repo', 'issue', 'preview-base-url', 'publish', 'dry-run', 'issue-file'],
  adopt: ['job-id', 'rev', 'repo', 'issue'],
  'log-improvement': ['step', 'job-id', 'rev', 'symptom', 'cause', 'action', 'expected'],
};

function number(option) {
  requireThat(typeof option === 'string' && /^\d+$/.test(option), '版または Issue の正の整数を指定してください');
  return validateRevision(Number(option));
}

function print(value) {
  console.log(JSON.stringify(value, null, 2));
}

async function main(args) {
  const [command, ...flags] = args;
  if (!command || command === '--help' || flags.includes('--help')) {
    console.log(help);
    return;
  }
  requireThat(Object.hasOwn(argumentsFor, command), '不明なコマンド: ' + command);
  const options = Object.fromEntries([...argumentsFor[command], 'root'].map(name => [
    name, { type: ['publish', 'dry-run'].includes(name) ? 'boolean' : 'string' },
  ]));
  const { values } = parseArgs({ args: flags, options });
  const root = resolve(values.root ?? fileURLToPath(new URL('..', import.meta.url)));
  if (command === 'process-issue') {
    const action = () => processIssue({
      root, repo: values.repo, issue: number(values.issue), issueFile: values['issue-file'],
      dryRun: values['dry-run'], publish: values.publish, base: values['preview-base-url'],
    });
    const comment = values['dry-run'] ? await action() : await withWorkspaceLock(root, action);
    process.stdout.write(comment ?? '未処理の依頼はありません。\n');
    return;
  }
  return withWorkspaceLock(root, async () => {
    if (command === 'run-local') {
      let rawJob;
      let sourceDir;
      const sourceFiles = new Map();
      if (values.job) {
        requireThat(Object.keys(values).every(key => ['job', 'root'].includes(key)), '--job は直接指定のオプションと併用できません');
        const file = resolve(values.job);
        rawJob = await readJson(file);
        sourceDir = dirname(file);
      } else {
        const inputs = {};
        if (values.reference) {
          inputs.reference = 'input/reference.png';
          sourceFiles.set(inputs.reference, resolve(values.reference));
        }
        rawJob = {
          jobId: values['job-id'], revision: values.rev ? number(values.rev) : 1,
          baseRevision: values['base-rev'] ? number(values['base-rev']) : null, kind: values.kind,
          step: values.step, request: values.request, change: values.change, keep: values.keep, inputs,
        };
      }
      const outcome = await runLocal({ root, rawJob, sourceDir, sourceFiles });
      print(outcome);
      if (outcome.result.status === 'blocked') process.exitCode = 1;
      return;
    }
    const id = values['job-id'];
    const revision = number(values.rev);
    if (command === 'adopt') {
      requireThat(Boolean(values.repo) === Boolean(values.issue), '--repo と --issue はセットで指定してください');
      print(values.repo ? await postAdoption({ root, repo: values.repo, issue: number(values.issue), id, revision })
        : await adoptRevision(root, id, revision));
    } else {
      print(await logImprovement(root, { ...values, jobId: id, revision }));
    }
  });
}

main(process.argv.slice(2)).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
