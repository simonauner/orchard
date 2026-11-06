// Wraps one Claude Code process. Pure Node, no Electron dependency,
// so it can be tested on its own.
const { spawn } = require('node:child_process');
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
        // Edits stay inside the agent's working folder.
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

  stop() {
    if (this.proc && !this.proc.killed) this.proc.kill();
  }
}

module.exports = { Agent };
