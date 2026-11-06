const { app, BrowserWindow, ipcMain, dialog, Notification } = require('electron');
const path = require('node:path');
const { Agent, createWorktree, removeWorktree } = require('./agent');

let win = null;
const agents = new Map();
let nextId = 1;

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
  return { id: a.id, cwd: a.cwd, status: a.status, name: a.task, branch: a.worktree.branch };
}

ipcMain.handle('agent:create', async (_e, task) => {
  const res = await dialog.showOpenDialog(win, { title: 'Välj git-repo', properties: ['openDirectory'] });
  if (res.canceled || !res.filePaths[0]) return null;

  let worktree;
  try {
    worktree = await createWorktree(res.filePaths[0], String(task ?? ''));
  } catch (e) {
    return { error: e.message };
  }

  const agent = new Agent({ id: nextId++, cwd: worktree.dir });
  agent.task = String(task).trim();
  agent.worktree = worktree;
  agents.set(agent.id, agent);

  agent.on('event', (event) => toUi('agent:event', agent.id, event));
  agent.on('status', (status) => {
    toUi('agent:status', agent.id, status);
    if (status === 'done' && win && !win.isDestroyed() && !win.isFocused()) {
      new Notification({ title: 'Agent klar', body: agent.task }).show();
    }
  });

  agent.start();
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
app.whenReady().then(createWindow);
