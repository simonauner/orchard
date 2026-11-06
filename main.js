const { app, BrowserWindow, ipcMain, dialog, Notification } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { Agent, createWorktree, removeWorktree, repoRoot } = require('./agent');

let win = null;
const agents = new Map();
let nextId = 1;

// Workspaces = repo roots the user has added, kept across restarts.
const workspacesFile = () => path.join(app.getPath('userData'), 'workspaces.json');
let workspaces = [];
function loadWorkspaces() {
  try {
    workspaces = JSON.parse(fs.readFileSync(workspacesFile(), 'utf8')).filter((w) => typeof w === 'string');
  } catch {
    workspaces = []; // first run or unreadable file
  }
}
function saveWorkspaces() {
  fs.mkdirSync(path.dirname(workspacesFile()), { recursive: true });
  fs.writeFileSync(workspacesFile(), JSON.stringify(workspaces, null, 2));
}

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
  return { id: a.id, status: a.status, name: a.task, branch: a.worktree.branch, workspace: a.worktree.root };
}

ipcMain.handle('workspaces:list', () => workspaces);

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
    agent = new Agent({ id: nextId++, cwd: workspace, model: model || null, effort: effort || null });
    agent.worktree = await createWorktree(workspace, prompt.split('\n')[0]);
  } catch (e) {
    return { error: e.message };
  }
  agent.cwd = agent.worktree.dir;
  agent.task = prompt.split('\n')[0].slice(0, 60);
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
  return publicInfo(agent);
});

ipcMain.handle('agent:remove', async (_e, id) => {
  const agent = agents.get(id);
  if (!agent) return { ok: true };
  await agent.stop();
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

// Never leave orphaned claude processes behind.
app.on('before-quit', () => agents.forEach((a) => a.stop()));
app.on('window-all-closed', () => app.quit());
app.whenReady().then(() => {
  loadWorkspaces();
  createWindow();
});
