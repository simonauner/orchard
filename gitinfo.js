// Git info for an agent's worktree, like Conductor's panel: its PRs (via gh), deployment links and the diff.
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileP = promisify(execFile);
const run = (cmd, cwd, args) => execFileP(cmd, args, { cwd, timeout: 20000, maxBuffer: 10 * 1024 * 1024 }).then((r) => r.stdout.trim());
const gh = (cwd, ...args) => run('gh', cwd, args);
const git = (cwd, ...args) => run('git', cwd, args);

// One word for the PR, checked in the order that matters most to the user.
function prStatus(pr) {
  if (pr.state === 'MERGED') return 'Merged';
  if (pr.state === 'CLOSED') return 'Closed';
  if (pr.isDraft) return 'Draft';
  const checks = pr.statusCheckRollup || [];
  // CheckRun has status/conclusion, StatusContext has state.
  const result = (c) => c.conclusion || c.state || '';
  if (checks.some((c) => ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(result(c)))) return 'Checks failing';
  if (checks.some((c) => (c.status && c.status !== 'COMPLETED') || result(c) === 'PENDING')) return 'Checks running';
  if (pr.mergeable === 'CONFLICTING') return 'Conflicts';
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return 'Changes requested';
  if (pr.reviewDecision === 'REVIEW_REQUIRED') return 'Review required';
  return 'Ready to merge';
}

// Same place Conductor's "View deployment" comes from: GitHub deployments (Vercel, Netlify, …) for the PR's head commit.
async function deploymentUrl(cwd, sha) {
  try {
    const deps = JSON.parse(await gh(cwd, 'api', `repos/{owner}/{repo}/deployments?sha=${sha}&per_page=1`));
    if (!deps[0]) return null;
    const statuses = JSON.parse(await gh(cwd, 'api', `repos/{owner}/{repo}/deployments/${deps[0].id}/statuses?per_page=1`));
    return statuses[0]?.environment_url || statuses[0]?.target_url || null;
  } catch {
    return null; // no access to deployments: just no link
  }
}

// All PRs ever opened from the worktree's branch, newest first.
async function pullRequests(cwd, branch) {
  const fields = 'number,title,url,state,isDraft,mergeable,reviewDecision,headRefOid,baseRefName,statusCheckRollup';
  const prs = JSON.parse(await gh(cwd, 'pr', 'list', '--head', branch, '--state', 'all', '--json', fields));
  return Promise.all(prs.map(async (pr) => ({
    number: pr.number, title: pr.title, url: pr.url, baseRefName: pr.baseRefName, status: prStatus(pr),
    deploymentUrl: pr.state === 'OPEN' ? await deploymentUrl(cwd, pr.headRefOid) : null,
  })));
}

// Committed and uncommitted changes since the branch left `base`, plus untracked files.
async function changes(cwd, base) {
  const from = await git(cwd, 'merge-base', base, 'HEAD');
  const files = (await git(cwd, 'diff', '--numstat', from)).split('\n').filter(Boolean).map((l) => {
    const [add, del, file] = l.split('\t');
    return { file, add: add === '-' ? null : Number(add), del: del === '-' ? null : Number(del) }; // '-' = binary
  });
  for (const file of (await git(cwd, 'ls-files', '--others', '--exclude-standard')).split('\n').filter(Boolean))
    files.push({ file, add: null, del: null, untracked: true });
  return files;
}

async function gitInfo(cwd, branch) {
  let prs = [], ghError = null;
  try {
    prs = await pullRequests(cwd, branch);
  } catch (e) {
    ghError = e.code === 'ENOENT' ? 'Install the GitHub CLI (gh) to see pull requests.' : (e.stderr?.trim() || e.message).split('\n')[0];
  }
  // Diff against the open PR's base, otherwise the remote's default branch.
  const openPr = prs.find((p) => p.status !== 'Merged' && p.status !== 'Closed');
  let base = openPr ? `origin/${openPr.baseRefName}` : null;
  if (!base) base = await git(cwd, 'rev-parse', '--abbrev-ref', 'origin/HEAD').catch(() => 'HEAD');
  let files = [], diffError = null;
  try {
    files = await changes(cwd, base);
  } catch (e) {
    diffError = (e.stderr?.trim() || e.message).split('\n')[0];
  }
  return { prs, ghError, base, files, diffError };
}

// Uses whichever merge method the repo allows, preferring a merge commit like GitHub's default button.
async function mergePr(cwd, number) {
  const repo = JSON.parse(await gh(cwd, 'repo', 'view', '--json', 'mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed'));
  const method = repo.mergeCommitAllowed ? '--merge' : repo.squashMergeAllowed ? '--squash' : '--rebase';
  await gh(cwd, 'pr', 'merge', String(number), method);
}

module.exports = { gitInfo, mergePr, prStatus };
