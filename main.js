const { app, BrowserWindow, ipcMain, dialog, Notification } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { Agent, checkExecutable, claudeStatus, createWorktree, removeWorktree, repoRoot, slugify } = require('./agent');

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
  return { id: a.id, status: a.status, name: a.task, branch: a.worktree.branch, workspace: a.worktree.root, model: a.model, effort: a.effort };
}

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
  agents.set(agent.id, agent);

  agent.on('event', (event) => toUi('agent:event', agent.id, event));
  agent.on('status', (status) => {
    toUi('agent:status', agent.id, status);
    if (status === 'done' && win && !win.isDestroyed() && !win.isFocused()) {
      new Notification({ title: 'Agent done', body: agent.task }).show();
    }
  });

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
  toUi('agent:info', publicInfo(agent));
  agent.start();
  agent.send(prompt);
}

ipcMain.handle('agent:remove', async (_e, id) => {
  const agent = agents.get(id);
  if (!agent) return { ok: true };
  await agent.stop();
  try {
    if (agent.worktree.dir) await removeWorktree(agent.worktree);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  agents.delete(id);
  return { ok: true };
});

ipcMain.handle('agent:send', (_e, id, text) => agents.get(id)?.send(text) ?? false);
ipcMain.handle('agent:stop', (_e, id) => agents.get(id)?.stop());

// Never leave orphaned claude processes behind.
app.on('before-quit', () => agents.forEach((a) => a.stop()));
app.on('window-all-closed', () => app.quit());
app.whenReady().then(() => {
  workspaces = [].concat(readJson('workspaces.json', [])).filter((w) => typeof w === 'string');
  const saved = readJson('settings.json', {});
  settings = { claudePath: typeof saved.claudePath === 'string' ? saved.claudePath : '' };
  createWindow();
});
