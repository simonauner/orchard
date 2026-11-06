const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig, scriptEnv, runScript } = require('../scripts');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'orchard-scripts-'));
const write = (dir, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};

(async () => {
  // No config file.
  assert.strictEqual(loadConfig(tmp()), null);

  // Conductor settings.toml, shaped like tradera/marketplace.
  const repo = tmp();
  write(repo, '.conductor/settings.toml', `
[prompts]
create_pr = "x"
[scripts]
setup = "./scripts/worktree-setup"
archive = ""
[scripts.run."Web x Core"]
command = "./scripts/worktree-run web core"
default = true
icon = "earth"
[scripts.run.Core]
command = "./scripts/worktree-run-core"
[scripts.run.iOS]
command = "./scripts/worktree-run-ios"
available_in = ["local"]
[scripts.run.Cloudy]
command = "x"
available_in = ["cloud"]
`);
  assert.deepStrictEqual(loadConfig(repo), {
    file: '.conductor/settings.toml',
    setup: './scripts/worktree-setup',
    archive: '',
    run: [
      { name: 'Web x Core', command: './scripts/worktree-run web core', default: true },
      { name: 'Core', command: './scripts/worktree-run-core', default: false },
      { name: 'iOS', command: './scripts/worktree-run-ios', default: false },
    ],
  });

  // .orchard wins over .conductor.
  write(repo, '.orchard/settings.toml', '[scripts]\nsetup = "make"\n');
  assert.deepStrictEqual(loadConfig(repo), { file: '.orchard/settings.toml', setup: 'make', archive: '', run: [] });

  // Legacy conductor.json with one run command.
  const legacy = tmp();
  write(legacy, 'conductor.json', JSON.stringify({ scripts: { setup: 'npm i', run: 'npm start', archive: 'rm -rf x' } }));
  assert.deepStrictEqual(loadConfig(legacy), {
    file: 'conductor.json', setup: 'npm i', archive: 'rm -rf x', run: [{ name: 'Run', command: 'npm start', default: false }],
  });

  // Broken file gives a readable error.
  const broken = tmp();
  write(broken, '.orchard/settings.toml', '[scripts\n');
  assert.throws(() => loadConfig(broken), /Could not read \.orchard\/settings\.toml/);

  // Scripts get Conductor's variables and run in the worktree.
  const dir = tmp();
  const lines = [];
  const job = runScript('echo "$CONDUCTOR_PORT $CONDUCTOR_WORKSPACE_NAME $ORCHARD_ROOT_PATH"; pwd -P', {
    cwd: dir, env: scriptEnv({ root: '/r', dir, port: 41010 }), onLine: (l) => lines.push(l),
  });
  assert.strictEqual(await job.done, 0);
  assert.deepStrictEqual(lines, [`41010 ${path.basename(dir)} /r`, fs.realpathSync(dir)]);

  // kill() takes down children the script started, not only the shell.
  const pidFile = path.join(dir, 'child.pid');
  const long = runScript(`sleep 30 & echo $! > ${pidFile}; wait`, { cwd: dir, env: process.env, onLine: () => {} });
  while (!fs.existsSync(pidFile) || !fs.readFileSync(pidFile, 'utf8').trim()) await new Promise((r) => setTimeout(r, 20));
  const child = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.strictEqual(await long.kill(), 'SIGTERM');
  await new Promise((r) => setTimeout(r, 100));
  assert.throws(() => process.kill(child, 0), /ESRCH/);

  console.log('scripts tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
