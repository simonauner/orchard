const { app, BrowserWindow, ipcMain, dialog, Notification } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { Agent, checkExecutable, claudeStatus, createWorktree, removeWorktree, repoRoot } = require('./agent');
const { loadConfig, scriptEnv, runScript } = require('./scripts');

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
}

// Processes can exit after the window is gone; sending to a destroyed window throws.
function toUi(...args) {
  if (win && !win.isDestroyed()) win.webContents.send(...args);
}

function publicInfo(a) {
  return {
    id: a.id, status: a.status, name: a.task, branch: a.worktree.branch, workspace: a.worktree.root,
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

ipcMain.handle('workspaces:list', () => workspaces);

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

  let agent;
  try {
    // Validates model/effort before anything is created on disk.
    agent = new Agent({ id: nextId++, cwd: workspace, command: claudeCommand(), model: model || null, effort: effort || null });
    agent.worktree = await createWorktree(workspace, prompt.split('\n')[0]);
  } catch (e) {
    return { error: e.message };
  }
  agent.cwd = agent.worktree.dir;
  agent.task = prompt.split('\n')[0].slice(0, 60);
  // Ten ports per agent, like Conductor. shortcut: not checked for being free, probe if collisions show up.
  agent.port = 41000 + (agent.id % 400) * 10;
  agent.jobs = { setup: null, run: null };
  let configError = null;
  try {
    agent.config = loadConfig(agent.worktree.dir);
  } catch (e) {
    configError = e.message;
  }
  agents.set(agent.id, agent);

  agent.on('event', (event) => toUi('agent:event', agent.id, event));
  agent.on('status', (status) => {
    toUi('agent:status', agent.id, status);
    if (status === 'done' && win && !win.isDestroyed() && !win.isFocused()) {
      new Notification({ title: 'Agent done', body: agent.task }).show();
    }
  });

  agent.start();
  agent.send(prompt);
  // Like Conductor, the agent starts right away while setup runs next to it.
  setImmediate(() => {
    if (configError) toUi('agent:script', agent.id, 'setup', configError);
    else if (agent.config?.setup) startScript(agent, 'setup', agent.config.setup);
  });
  return publicInfo(agent);
});

ipcMain.handle('agent:remove', async (_e, id) => {
  const agent = agents.get(id);
  if (!agent) return { ok: true };
  await Promise.all([agent.stop(), stopJobs(agent)]);
  if (agent.config?.archive) {
    const code = await startScript(agent, 'setup', agent.config.archive).done;
    if (code !== 0) return { ok: false, error: `The archive script exited with ${code}; see the Setup tab.` };
  }
  try {
    await removeWorktree(agent.worktree);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  agents.delete(id);
  return { ok: true };
});

ipcMain.handle('agent:send', (_e, id, text) => agents.get(id)?.send(text) ?? false);
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
  const saved = readJson('settings.json', {});
  settings = { claudePath: typeof saved.claudePath === 'string' ? saved.claudePath : '' };
  createWindow();
});
