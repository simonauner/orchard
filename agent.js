// Wraps one Claude Code process. Pure Node, no Electron dependency,
// so it can be tested on its own.
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const readline = require('node:readline');

class Agent extends EventEmitter {
  constructor({ id, cwd, command = 'claude', args = null }) {
    super();
    this.id = id;
    this.cwd = cwd;
    this.command = command;
    this.args =
      args ||
      [
        '-p',
        '--input-format', 'stream-json',
        '--output-format', 'stream-json',
        '--verbose',
        // -p has no way to ask for approval, so every write was denied.
        // Edits stay inside the agent's own worktree.
        '--permission-mode', 'acceptEdits',
      ];
    this.sessionId = null;
    this.status = 'idle'; // idle | working | done | stopped | error
    this.proc = null;
  }

  setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.emit('status', status);
  }

  start() {
    this.proc = spawn(this.command, this.args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    readline.createInterface({ input: this.proc.stdout }).on('line', (line) => {
      if (!line.trim()) return;
      let evt;
      try {
        evt = JSON.parse(line);
      } catch {
        this.emit('event', { type: 'raw', text: line });
        return;
      }
      if (evt.session_id) this.sessionId = evt.session_id;
      this.emit('event', evt);
      if (evt.type === 'result') this.setStatus('done');
    });

    readline.createInterface({ input: this.proc.stderr }).on('line', (line) => {
      this.emit('event', { type: 'stderr', text: line });
    });

    this.proc.on('error', (err) => {
      this.emit('event', { type: 'stderr', text: String(err.message) });
      this.setStatus('error');
    });
    this.proc.on('exit', () => {
      if (this.status !== 'error') this.setStatus('stopped');
    });
  }

  send(text) {
    if (!this.proc || this.proc.killed || this.status === 'stopped') return false;
    const msg = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
    };
    this.proc.stdin.write(JSON.stringify(msg) + '\n');
    this.setStatus('working');
    return true;
  }

  // Resolves once the process has exited.
  stop() {
    const p = this.proc;
    if (!p || !p.pid || p.exitCode !== null || p.signalCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      p.once('exit', resolve);
      p.kill();
    });
  }
}

const execFileP = promisify(execFile);
async function git(cwd, ...args) {
  try {
    return (await execFileP('git', ['-C', cwd, ...args])).stdout.trim();
  } catch (e) {
    throw new Error(e.stderr?.trim() || e.message);
  }
}

function slugify(task) {
  return task
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// New branch agent/<slug> checked out in <repo>-worktrees/<slug>, next to the repo.
async function createWorktree(repo, task) {
  const slug = slugify(task);
  if (!slug) throw new Error('The task name must contain letters or digits.');
  const root = await git(repo, 'rev-parse', '--show-toplevel');
  const dir = path.join(`${root}-worktrees`, slug);
  const branch = `agent/${slug}`;
  await git(root, 'worktree', 'add', '-b', branch, dir);
  return { root, dir, branch };
}

// No --force: git refuses if there are uncommitted or untracked files, so nothing is lost.
// The branch is kept, it holds the agent's commits.
async function removeWorktree({ root, dir }) {
  await git(root, 'worktree', 'remove', dir);
}

module.exports = { Agent, createWorktree, removeWorktree, slugify };
