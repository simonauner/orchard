// Wraps one Claude Code process. Pure Node, no Electron dependency,
// so it can be tested on its own.
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const readline = require('node:readline');

// Allowlists: values become CLI arguments, so nothing else may pass ("--foo" would be read as a flag).
const MODELS = ['fable', 'opus', 'sonnet', 'haiku'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

class Agent extends EventEmitter {
  constructor({ id, cwd, command = 'claude', args = null, model = null, effort = null }) {
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
        // Everything else that needs approval, and AskUserQuestion, comes to us as a control_request.
        '--permission-prompt-tool', 'stdio',
      ];
    if (model) {
      if (!MODELS.includes(model)) throw new Error(`Unknown model: ${model}`);
      this.args.push('--model', model);
    }
    if (effort) {
      if (!EFFORTS.includes(effort)) throw new Error(`Unknown effort: ${effort}`);
      this.args.push('--effort', effort);
    }
    this.sessionId = null;
    this.status = 'idle'; // idle | working | waiting | done | stopped | error
    this.proc = null;
    this.pending = new Map(); // request_id -> the can_use_tool request awaiting an answer
  }

  setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.emit('status', status);
  }

  get running() {
    const p = this.proc;
    return !!p && !p.killed && p.exitCode === null && p.signalCode === null;
  }

  // A restarted agent continues its earlier conversation.
  start() {
    let args = this.args;
    if (this.sessionId) {
      // Read back from disk and passed as an argument, so it must not look like a flag.
      if (!/^[A-Za-z0-9][\w-]*$/.test(this.sessionId)) throw new Error(`Invalid session id: ${this.sessionId}`);
      args = [...args, '--resume', this.sessionId];
    }
    this.setStatus('idle');
    this.proc = spawn(this.command, args, {
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
      if (evt.type === 'control_request') {
        // We register no hooks or SDK MCP servers, so anything but can_use_tool is unexpected; never leave claude waiting.
        if (evt.request?.subtype !== 'can_use_tool') return this.write({ type: 'control_response', response: { subtype: 'error', request_id: evt.request_id, error: 'Unsupported request' } });
        this.pending.set(evt.request_id, evt.request);
        this.setStatus('waiting');
      }
      if (evt.type === 'control_cancel_request') this.pending.delete(evt.request_id);
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
      this.pending.clear();
      if (this.status !== 'error') this.setStatus('stopped');
    });
  }

  write(msg) {
    this.proc.stdin.write(JSON.stringify(msg) + '\n');
  }

  send(text) {
    if (!this.proc || this.proc.killed || this.status === 'stopped') return false;
    this.write({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
    this.setStatus('working');
    return true;
  }

  // Answers a can_use_tool request. The tool input is the one claude sent, so the UI cannot change a command;
  // answers ({question: label}) are only taken for AskUserQuestion. Returns false if the request is gone.
  respond(requestId, { allow, answers, message } = {}) {
    const req = this.pending.get(requestId);
    if (!req || !this.running) return false;
    this.pending.delete(requestId);
    let response;
    if (!allow) response = { behavior: 'deny', message: String(message || 'The user denied this.') };
    else if (req.tool_name === 'AskUserQuestion') {
      const asked = new Set((req.input?.questions ?? []).map((q) => q.question));
      const picked = Object.fromEntries(Object.entries(answers ?? {}).filter(([q, a]) => asked.has(q) && typeof a === 'string'));
      response = { behavior: 'allow', updatedInput: { ...req.input, answers: picked } };
    } else response = { behavior: 'allow', updatedInput: req.input };
    this.write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
    this.emit('event', { type: 'control_answer', request_id: requestId, behavior: response.behavior, answers: response.updatedInput?.answers });
    if (!this.pending.size) this.setStatus('working');
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

// What the settings view shows: version and login, straight from the CLI.
async function claudeStatus(command = 'claude', args = []) {
  const run = (...a) => execFileP(command, [...args, ...a], { timeout: 15000 }).then((r) => r.stdout.trim());
  try {
    const [version, auth] = await Promise.all([run('--version'), run('auth', 'status')]);
    return { ok: true, version: version.split(' ')[0], ...JSON.parse(auth) };
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: false, error: `Claude Code not found: ${command}` };
    return { ok: false, error: e.stderr?.trim() || e.message };
  }
}

// What claude picks when no --model/--effort is passed: env, then local > project > user settings.
// shortcut: ignores managed (enterprise) settings, read them too if someone relies on those.
function claudeDefaults(cwd, env = process.env) {
  const configDir = env.CLAUDE_CONFIG_DIR || path.join(require('node:os').homedir(), '.claude');
  const files = [path.join(configDir, 'settings.json'), path.join(cwd, '.claude', 'settings.json'), path.join(cwd, '.claude', 'settings.local.json')];
  const out = { model: null, effort: null };
  for (const f of files) {
    let s;
    try {
      s = JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch {
      continue; // missing or unreadable: claude skips it too
    }
    if (typeof s?.model === 'string') out.model = s.model;
    if (typeof s?.effortLevel === 'string') out.effort = s.effortLevel;
  }
  return { model: env.ANTHROPIC_MODEL || out.model, effort: env.CLAUDE_CODE_EFFORT_LEVEL || out.effort };
}

// A custom executable must be an absolute path to something we may run.
function checkExecutable(file) {
  if (!path.isAbsolute(file)) throw new Error('The path must be absolute.');
  try {
    fs.accessSync(file, fs.constants.X_OK);
  } catch {
    throw new Error(`Not an executable file: ${file}`);
  }
  if (!fs.statSync(file).isFile()) throw new Error(`Not an executable file: ${file}`);
}

const repoRoot = (dir) => git(dir, 'rev-parse', '--show-toplevel');

async function branchExists(root, branch) {
  try {
    await git(root, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`);
    return true;
  } catch {
    return false;
  }
}

// New branch orchard/<slug> checked out in <repo>-orchard/<slug>, next to the repo.
// A taken slug gets -2, -3, ... so similar tasks never collide.
async function createWorktree(repo, task) {
  const base = slugify(task).slice(0, 40).replace(/-+$/, '');
  if (!base) throw new Error('The task must contain letters or digits.');
  const root = await repoRoot(repo);
  for (let n = 1; n <= 100; n++) {
    const slug = n === 1 ? base : `${base}-${n}`;
    const dir = path.join(`${root}-orchard`, slug);
    const branch = `orchard/${slug}`;
    if (fs.existsSync(dir) || (await branchExists(root, branch))) continue;
    await git(root, 'worktree', 'add', '-b', branch, dir);
    return { root, dir, branch };
  }
  throw new Error(`No free branch name for orchard/${base}`);
}

// Without force git refuses if there are uncommitted or untracked files, so nothing is lost;
// the error then carries `dirty`, those files, for the user to decide on.
// The branch is kept, it holds the agent's commits.
async function removeWorktree({ root, dir }, force = false) {
  try {
    await git(root, 'worktree', 'remove', ...(force ? ['--force'] : []), dir);
  } catch (e) {
    e.dirty = await git(dir, 'status', '--porcelain').then((out) => out.split('\n').filter(Boolean), () => []);
    throw e;
  }
}

module.exports = {
  Agent, MODELS, EFFORTS, checkExecutable, claudeDefaults, claudeStatus, createWorktree, removeWorktree, repoRoot, slugify,
};
