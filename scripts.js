// Per-repo setup/run/archive scripts. Reads Orchard's own .orchard/settings.toml,
// or Conductor's files (same format) so repos set up for Conductor work as is.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { parse } = require('smol-toml');

const FILES = ['.orchard/settings.toml', '.conductor/settings.toml', 'conductor.json'];
const str = (v) => (typeof v === 'string' ? v.trim() : '');

// Returns { file, setup, archive, run: [{ name, command, default }] }, or null without a config file.
function loadConfig(dir) {
  for (const rel of FILES) {
    const file = path.join(dir, rel);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    let scripts;
    try {
      scripts = (rel.endsWith('.json') ? JSON.parse(text) : parse(text)).scripts || {};
    } catch (e) {
      throw new Error(`Could not read ${rel}: ${e.message}`);
    }
    // conductor.json has a single run command; settings.toml has a table of named ones.
    const runs = typeof scripts.run === 'string' ? { Run: { command: scripts.run } } : scripts.run || {};
    const run = Object.entries(runs)
      .map(([name, r]) => ({ name, command: str(r?.command), default: r?.default === true, availableIn: r?.available_in }))
      .filter((r) => r.command && (!Array.isArray(r.availableIn) || r.availableIn.includes('local')))
      .map(({ availableIn, ...r }) => r);
    return { file: rel, setup: str(scripts.setup), archive: str(scripts.archive), run };
  }
  return null;
}

// The variables Conductor gives its scripts; repos read CONDUCTOR_PORT to pick their ten ports.
function scriptEnv({ root, dir, port }) {
  const vars = { ROOT_PATH: root, WORKSPACE_PATH: dir, WORKSPACE_NAME: path.basename(dir), PORT: String(port) };
  const env = { ...process.env };
  for (const [k, v] of Object.entries(vars)) env[`CONDUCTOR_${k}`] = env[`ORCHARD_${k}`] = v;
  return env;
}

// Runs a command in a login shell (an app started from Finder lacks the user's PATH).
// Own process group, so kill() takes down dev servers the script started too.
function runScript(command, { cwd, env, onLine }) {
  const proc = spawn(process.env.SHELL || '/bin/sh', ['-lc', command], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  readline.createInterface({ input: proc.stdout }).on('line', onLine);
  readline.createInterface({ input: proc.stderr }).on('line', onLine);
  const done = new Promise((resolve) => {
    proc.on('error', (e) => { onLine(e.message); resolve(-1); });
    proc.on('exit', (code, signal) => resolve(signal ? signal : code));
  });
  const kill = () => {
    if (proc.exitCode !== null || proc.signalCode !== null) return done;
    try { process.kill(-proc.pid, 'SIGTERM'); } catch { /* already gone */ }
    return done;
  };
  return { done, kill };
}

module.exports = { loadConfig, scriptEnv, runScript };
