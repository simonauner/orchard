// agents: { id, name, status, branch, workspace, lines: [{cls, text}] }
const state = { workspaces: [], agents: new Map(), active: null };

const $ = (id) => document.getElementById(id);
const listEl = $('list'), logEl = $('log'), input = $('text');
const basename = (p) => p.split('/').filter(Boolean).pop();

function addLine(agent, cls, text) {
  agent.lines.push({ cls, text });
  if (state.active === agent.id) appendLineEl({ cls, text });
}

function appendLineEl({ cls, text }) {
  const d = document.createElement('div');
  d.className = 'msg ' + cls;
  d.textContent = text;
  logEl.appendChild(d);
  logEl.scrollTop = logEl.scrollHeight;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function renderList() {
  listEl.innerHTML = '';
  if (!state.workspaces.length) listEl.appendChild(el('div', 'hint', 'Add a git repo with + to get started.'));
  for (const ws of state.workspaces) {
    const head = el('div', 'ws');
    head.title = ws;
    head.appendChild(el('span', null, basename(ws)));
    const plus = el('button', 'icon', '+');
    plus.title = plus.ariaLabel = `New agent in ${basename(ws)}`;
    plus.onclick = () => showCreate(ws);
    head.appendChild(plus);
    listEl.appendChild(head);

    for (const a of state.agents.values()) {
      if (a.workspace !== ws) continue;
      const item = el('div', 'item' + (a.id === state.active ? ' active' : ''));
      item.title = `${a.status} · ${a.branch}`;
      item.appendChild(el('span', `dot ${a.status}`));
      item.appendChild(el('span', 'name', a.name));
      const rm = el('button', 'icon rm', '×');
      rm.title = rm.ariaLabel = 'Remove agent and worktree';
      rm.onclick = (e) => { e.stopPropagation(); remove(a); };
      item.appendChild(rm);
      item.onclick = () => select(a.id);
      listEl.appendChild(item);
    }
  }
  $('navCreate').classList.toggle('active', state.active == null);
}

function renderWorkspaceSelect(selected) {
  const sel = $('ws');
  sel.innerHTML = '';
  if (!state.workspaces.length) sel.appendChild(el('option', null, 'No workspaces yet'));
  for (const ws of state.workspaces) {
    const o = el('option', null, basename(ws));
    o.value = ws;
    sel.appendChild(o);
  }
  if (selected) sel.value = selected;
}

function showCreate(ws) {
  state.active = null;
  $('chatView').hidden = true;
  $('createView').hidden = false;
  $('err').textContent = '';
  renderWorkspaceSelect(ws || $('ws').value);
  renderList();
  $('prompt').focus();
}

function select(id) {
  state.active = id;
  const a = state.agents.get(id);
  $('createView').hidden = true;
  $('chatView').hidden = false;
  $('title').querySelector('b').textContent = a.name;
  $('title').querySelector('small').textContent = `${basename(a.workspace)} · ${a.branch}`;
  logEl.innerHTML = '';
  a.lines.forEach(appendLineEl);
  input.focus();
  renderList();
}

// Turn one stream-json event into readable lines.
function handleEvent(agent, evt) {
  if (evt.type === 'assistant') {
    for (const block of evt.message?.content ?? []) {
      if (block.type === 'text') addLine(agent, 'assistant', block.text);
      else if (block.type === 'tool_use')
        addLine(agent, 'tool', `🔧 ${block.name} ${JSON.stringify(block.input).slice(0, 200)}`);
    }
  } else if (evt.type === 'result') {
    const cost = evt.total_cost_usd != null ? ` · $${evt.total_cost_usd.toFixed(4)}` : '';
    addLine(agent, 'meta', `done${cost}`);
    for (const d of evt.permission_denials ?? [])
      addLine(agent, 'meta', `⛔ denied: ${d.tool_name} ${JSON.stringify(d.tool_input).slice(0, 200)}`);
  } else if (evt.type === 'stderr' || evt.type === 'raw') {
    addLine(agent, 'meta', evt.text);
  }
}

$('navCreate').onclick = () => showCreate();

$('addWs').onclick = async () => {
  const res = await window.agents.addWorkspace();
  if (!res) return;
  if (res.error) { showCreate(); $('err').textContent = res.error; return; }
  state.workspaces = res.workspaces;
  showCreate(res.root);
};

// Enter creates, Shift+Enter adds a new line.
$('prompt').onkeydown = (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('createForm').requestSubmit(); }
};

$('createForm').onsubmit = async (e) => {
  e.preventDefault();
  const btn = $('createBtn');
  if (btn.disabled) return;
  $('err').textContent = '';
  btn.disabled = true; // worktree add takes a moment; avoid double-creating
  const prompt = $('prompt').value.trim();
  try {
    const info = await window.agents.create({ workspace: $('ws').value, prompt, model: $('model').value, effort: $('effort').value });
    if (info.error) { $('err').textContent = info.error; return; }
    $('prompt').value = '';
    const agent = { ...info, lines: [] };
    state.agents.set(info.id, agent);
    addLine(agent, 'you', '› ' + prompt);
    select(info.id);
  } finally {
    btn.disabled = false;
  }
};

async function remove(agent) {
  if (!confirm(`Remove agent "${agent.name}" and its worktree? The branch ${agent.branch} is kept.`)) return;
  const res = await window.agents.remove(agent.id);
  if (!res.ok) { addLine(agent, 'meta', `Could not remove the worktree: ${res.error}`); return; }
  state.agents.delete(agent.id);
  if (state.active === agent.id) showCreate(agent.workspace);
  else renderList();
}

$('form').onsubmit = async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  const agent = state.agents.get(state.active);
  if (!text || !agent) return;
  input.value = '';
  addLine(agent, 'you', '› ' + text);
  const ok = await window.agents.send(agent.id, text);
  if (!ok) addLine(agent, 'meta', 'The agent is no longer running.');
};

window.agents.onEvent((id, evt) => {
  const a = state.agents.get(id);
  if (a) handleEvent(a, evt);
});
window.agents.onStatus((id, status) => {
  const a = state.agents.get(id);
  if (a) { a.status = status; renderList(); }
});

window.agents.workspaces().then((ws) => {
  state.workspaces = ws;
  showCreate();
});
