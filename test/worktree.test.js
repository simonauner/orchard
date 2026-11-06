// Tests createWorktree/removeWorktree against a throwaway git repo.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createWorktree, removeWorktree, repoRoot, slugify } = require('../agent');

process.env.LC_ALL = 'C'; // assertions match git's English messages
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();

(async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-')));
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');

  try {
    assert.strictEqual(slugify('  Fix Åland bug!! '), 'fix-aland-bug');
    await assert.rejects(createWorktree(repo, '!!!'), /letters or digits/);
    await assert.rejects(createWorktree(tmp, 'x'), /not a git repository/);

    // A subfolder of the repo resolves to the repo root.
    fs.mkdirSync(path.join(repo, 'sub'));
    const wt = await createWorktree(path.join(repo, 'sub'), 'Fixa login');
    assert.deepStrictEqual(wt, {
      root: repo,
      dir: path.join(tmp, 'repo-worktrees', 'fixa-login'),
      branch: 'agent/fixa-login',
    });
    assert.strictEqual(git(wt.dir, 'branch', '--show-current'), 'agent/fixa-login');

    assert.strictEqual(await repoRoot(path.join(repo, 'sub')), repo);

    // Same task again gets a numbered slug instead of failing.
    const wt2 = await createWorktree(repo, 'fixa login');
    assert.strictEqual(wt2.branch, 'agent/fixa-login-2');
    await removeWorktree(wt2);

    // Long prompts are cut to 40 chars without a trailing dash.
    assert.strictEqual((await createWorktree(repo, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa b')).branch, 'agent/' + 'a'.repeat(39));
    const long = await createWorktree(repo, 'Refactor the payment service so that retries are idempotent');
    assert.strictEqual(long.branch, 'agent/refactor-the-payment-service-so-that-ret');
    await removeWorktree(long);

    // Uncommitted work blocks removal so nothing is lost.
    fs.writeFileSync(path.join(wt.dir, 'wip.txt'), 'x');
    await assert.rejects(removeWorktree(wt), /untracked|modified/);
    assert.ok(fs.existsSync(path.join(wt.dir, 'wip.txt')));

    fs.rmSync(path.join(wt.dir, 'wip.txt'));
    await removeWorktree(wt);
    assert.ok(!fs.existsSync(wt.dir));
    assert.ok(!git(repo, 'worktree', 'list').includes('fixa-login'));
    assert.strictEqual(git(repo, 'branch', '--list', 'agent/fixa-login'), 'agent/fixa-login'); // branch kept
    console.log('OK: worktree create, validate, refuse dirty remove, remove');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exit(1); });
