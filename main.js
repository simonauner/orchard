const { app, BrowserWindow, ipcMain, dialog, Notification, shell, clipboard } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { Agent, checkExecutable, claudeDefaults, claudeStatus, createWorktree, removeWorktree, repoRoot, slugify } = require('./agent');
const { loadConfig, scriptEnv, runScript } = require('./scripts');

// The native Claude Code installer puts `claude` in ~/.local/bin, which shells and GUI launches often lack.
const localBin = path.join(require('node:os').homedir(), '.local', 'bin');
if (!process.env.PATH.split(path.delimiter).includes(localBin)) process.env.PATH += path.delimiter + localBin;

let win = null;
const agents = new Map();
let nextId = 1;

// Small JSON files in the user data folder, kept across restarts.
const storeFile = (name) => path.join(app.getPath('userData'), name);
function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(storeFile(name), 'utf8'));
  } catch {
    return fallback; // first run or unreadable file
  }
}
function writeJson(name, value) {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(storeFile(name), JSON.stringify(value, null, 2));
}

// Workspaces = repo roots the user has added.
let workspaces = [];
const saveWorkspaces = () => writeJson('workspaces.json', workspaces);
// Hidden workspaces stay usable but sit in a collapsed sidebar section.
let hidden = [];

// settings.claudePath: custom Claude Code executable, empty = `claude` from PATH.
let settings = { claudePath: '' };
const claudeCommand = () => settings.claudePath || 'claude';

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // Links in agent replies open in the browser; the app window never navigates away.
  const openLink = (url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); };
  win.webContents.on('will-navigate', (e, url) => { e.preventDefault(); openLink(url); });
  win.webContents.setWindowOpenHandler(({ url }) => { openLink(url); return { action: 'deny' }; });
}

// Processes can exit after the window is gone; sending to a destroyed window throws.
function toUi(...args) {
  if (win && !win.isDestroyed()) win.webContents.send(...args);
}

function publicInfo(a) {
  return {
    id: a.id, status: a.status, name: a.task, branch: a.worktree.branch, workspace: a.worktree.root, model: a.model, effort: a.effort,
    defaults: claudeDefaults(a.cwd), // the worktree once it exists, the repo before that
    configFile: a.config?.file || null, runs: a.config?.run.map((r) => ({ name: r.name, default: r.default })) || [],
  };
}

// kind: 'setup' | 'run'. Lines and state go to the agent's Setup/Run tabs.
function startScript(agent, kind, command) {
  const say = (line) => toUi('agent:script', agent.id, kind, line);
  say(`$ ${command}`);
  const job = runScript(command, { cwd: agent.worktree.dir, env: scriptEnv({ ...agent.worktree, port: agent.port }), onLine: say });
  agent.jobs[kind] = job;
  toUi('agent:scriptState', agent.id, kind, true);
  job.done.then((code) => {
    say(code === 0 ? '✓ finished' : `✗ exited with ${code}`);
    if (agent.jobs[kind] === job) {
      agent.jobs[kind] = null;
      toUi('agent:scriptState', agent.id, kind, false);
    }
  });
  return job;
}

const stopJobs = (agent) => Promise.all(Object.values(agent.jobs).filter(Boolean).map((j) => j.kill()));

ipcMain.handle('workspaces:list', () => ({ workspaces, hidden }));

ipcMain.handle('workspaces:setHidden', (_e, ws, hide) => {
  hidden = hidden.filter((w) => w !== ws);
  if (hide && workspaces.includes(ws)) hidden.push(ws);
  writeJson('hidden.json', hidden);
  return hidden;
});

// Only forgets the repo; nothing on disk is touched.
ipcMain.handle('workspaces:remove', (_e, ws) => {
  if ([...agents.values()].some((a) => a.worktree.root === ws)) return { error: 'Remove its agents first.' };
  workspaces = workspaces.filter((w) => w !== ws);
  hidden = hidden.filter((w) => w !== ws);
  saveWorkspaces();
  writeJson('hidden.json', hidden);
  return { workspaces, hidden };
});
ipcMain.handle('clipboard:write', (_e, data) => clipboard.write({ text: String(data.text ?? ''), html: data.html ? String(data.html) : undefined }));

ipcMain.handle('claude:defaults', (_e, workspace) => (workspaces.includes(workspace) ? claudeDefaults(workspace) : {}));

ipcMain.handle('settings:get', () => settings);
ipcMain.handle('settings:status', () => claudeStatus(claudeCommand()));

ipcMain.handle('settings:browseClaude', async () => {
  const res = await dialog.showOpenDialog(win, { title: 'Choose the Claude Code executable', properties: ['openFile'] });
  return res.canceled ? null : res.filePaths[0];
});

// Only affects agents created after the change.
ipcMain.handle('settings:setClaudePath', (_e, file) => {
  file = String(file ?? '').trim();
  try {
    if (file) checkExecutable(file);
  } catch (e) {
    return { error: e.message };
  }
  settings = { ...settings, claudePath: file };
  writeJson('settings.json', settings);
  return settings;
});

ipcMain.handle('workspaces:add', async () => {
  const res = await dialog.showOpenDialog(win, { title: 'Add a git repo as workspace', properties: ['openDirectory'] });
  if (res.canceled || !res.filePaths[0]) return null;
  try {
    const root = await repoRoot(res.filePaths[0]);
    if (!workspaces.includes(root)) {
      workspaces.push(root);
      saveWorkspaces();
    }
    return { root, workspaces };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('agent:create', async (_e, { workspace, prompt, model, effort } = {}) => {
  prompt = String(prompt ?? '').trim();
  if (!workspaces.includes(workspace)) return { error: 'Pick a workspace first.' };
  if (!prompt) return { error: 'Describe what you want to work on.' };

  if (!slugify(prompt.split('\n')[0])) return { error: 'The task must contain letters or digits.' };

  let agent;
  try {
    // Validates model/effort before anything is created on disk.
    agent = new Agent({ id: nextId++, cwd: workspace, command: claudeCommand(), model: model || null, effort: effort || null });
  } catch (e) {
    return { error: e.message };
  }
  agent.task = prompt.split('\n')[0].slice(0, 60);
  Object.assign(agent, { model: model || null, effort: effort || null });
  agent.worktree = { root: workspace, branch: null }; // filled in by setup()
  agent.status = 'setup';
  fs.rmSync(logFile(agent.id), { force: true }); // a leftover log from an unsaved agent with this id
  track(agent);

  // The UI shows the agent right away; the worktree and claude start behind it.
  setup(agent, prompt);
  return publicInfo(agent);
});

async function setup(agent, prompt) {
  let worktree;
  try {
    worktree = await createWorktree(agent.worktree.root, prompt.split('\n')[0]);
  } catch (e) {
    agent.emit('event', { type: 'stderr', text: `Could not create the worktree: ${e.message}` });
    agent.setStatus('error');
    return;
  }
  agent.worktree = worktree;
  if (!agents.has(agent.id)) return removeWorktree(worktree).catch(() => {}); // removed while setting up
  agent.cwd = worktree.dir;
  const configError = loadScripts(agent);
  saveAgents();
  toUi('agent:info', publicInfo(agent));
  send(agent, prompt);
  // Like Conductor, setup runs next to the agent rather than before it.
  if (configError) toUi('agent:script', agent.id, 'setup', configError);
  else if (agent.config?.setup) startScript(agent, 'setup', agent.config.setup);
}

// Reads the repo's setup/run/archive scripts from the worktree; returns an error message, if any.
function loadScripts(agent) {
  try {
    agent.config = loadConfig(agent.worktree.dir);
  } catch (e) {
    agent.config = null;
    return e.message;
  }
}

// Starts claude again (resuming its session) if it is not running, e.g. after a restart.
function send(agent, text) {
  if (!agent.worktree.dir) return false; // still setting up
  try {
    if (!agent.running) agent.start();
  } catch (e) {
    return false;
  }
  log(agent, { type: 'you', text });
  return agent.send(text);
}

// Agents survive restarts: agents.json has what is needed to resume, logs/<id>.jsonl the transcript.
const logFile = (id) => path.join(storeFile('logs'), `${id}.jsonl`);
function log(agent, event) {
  fs.mkdirSync(storeFile('logs'), { recursive: true });
  fs.appendFileSync(logFile(agent.id), JSON.stringify(event) + '\n');
}
function saveAgents() {
  const saved = [...agents.values()].filter((a) => a.worktree.dir); // not yet set up = nothing to resume
  writeJson('agents.json', saved.map((a) => ({
    id: a.id, task: a.task, model: a.model, effort: a.effort, worktree: a.worktree, sessionId: a.sessionId,
  })));
}

function track(agent) {
  agents.set(agent.id, agent);
  // Ten ports per agent, like Conductor. shortcut: not checked for being free, probe if collisions show up.
  agent.port = 41000 + (agent.id % 400) * 10;
  agent.jobs = { setup: null, run: null };
  agent.on('event', (event) => {
    log(agent, event);
    if (event.type === 'system' && event.subtype === 'init') saveAgents(); // new or resumed session id
    toUi('agent:event', agent.id, event);
  });
  agent.on('status', (status) => {
    toUi('agent:status', agent.id, status);
    if (status === 'done' && win && !win.isDestroyed() && !win.isFocused()) {
      new Notification({ title: 'Agent done', body: agent.task }).show();
    }
  });
}

function restoreAgents() {
  for (const s of [].concat(readJson('agents.json', []))) {
    if (!Number.isInteger(s?.id) || typeof s.worktree?.dir !== 'string') continue;
    nextId = Math.max(nextId, s.id + 1);
    try {
      const agent = new Agent({ id: s.id, cwd: s.worktree.dir, command: claudeCommand(), model: s.model, effort: s.effort });
      Object.assign(agent, { task: String(s.task), model: s.model, effort: s.effort, worktree: s.worktree, sessionId: s.sessionId || null });
      track(agent);
      loadScripts(agent); // a broken config just means no scripts for this agent
    } catch {
      // model/effort no longer valid: skip rather than crash on startup
    }
  }
}

ipcMain.handle('agent:remove', async (_e, id) => {
  const agent = agents.get(id);
  if (!agent) return { ok: true };
  await Promise.all([agent.stop(), stopJobs(agent)]);
  if (agent.config?.archive) {
    const code = await startScript(agent, 'setup', agent.config.archive).done;
    if (code !== 0) return { ok: false, error: `The archive script exited with ${code}; see the Setup tab.` };
  }
  try {
    if (agent.worktree.dir) await removeWorktree(agent.worktree);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  agents.delete(id);
  saveAgents();
  fs.rmSync(logFile(id), { force: true });
  return { ok: true };
});

ipcMain.handle('agent:list', () => [...agents.values()].map(publicInfo));
ipcMain.handle('agent:history', (_e, id) => {
  if (!agents.has(id)) return [];
  try {
    return fs.readFileSync(logFile(id), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return []; // no log yet
  }
});
ipcMain.handle('agent:send', (_e, id, text) => {
  const agent = agents.get(id);
  return agent ? send(agent, String(text)) : false;
});
ipcMain.handle('agent:stop', (_e, id) => agents.get(id)?.stop());

// One run at a time per agent; starting another stops the current one first.
ipcMain.handle('agent:run', async (_e, id, name) => {
  const agent = agents.get(id);
  const run = agent?.config?.run.find((r) => r.name === name);
  if (!run) return false;
  await agent.jobs.run?.kill();
  startScript(agent, 'run', run.command);
  return true;
});
ipcMain.handle('agent:runStop', (_e, id) => agents.get(id)?.jobs.run?.kill());

// Never leave orphaned claude processes behind.
app.on('before-quit', () => agents.forEach((a) => { a.stop(); stopJobs(a); }));
app.on('window-all-closed', () => app.quit());
app.whenReady().then(() => {
  workspaces = [].concat(readJson('workspaces.json', [])).filter((w) => typeof w === 'string');
  hidden = [].concat(readJson('hidden.json', [])).filter((w) => workspaces.includes(w));
  const saved = readJson('settings.json', {});
  settings = { claudePath: typeof saved.claudePath === 'string' ? saved.claudePath : '' };
  restoreAgents();
  createWindow();
});
