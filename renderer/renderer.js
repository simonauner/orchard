// agents: { id, name, status, branch, workspace, lines: [{cls, text}] }
const state = { workspaces: [], agents: new Map(), active: null, view: 'create' };

const $ = (id) => document.getElementById(id);
const listEl = $('list'), logEl = $('log'), input = $('text');
const basename = (p) => p.split('/').filter(Boolean).pop();

function addLine(agent, cls, text) {
  agent.lines.push({ cls, text });
  if (state.active === agent.id) appendLineEl({ cls, text });
}

function lineEl(line) {
  if (!line.lines) return el('div', 'msg ' + line.cls, line.text);
  const d = el('details', 'msg fold');
  d.appendChild(el('summary', null, line.text));
  for (const l of line.lines) d.appendChild(lineEl(l));
  return d;
}

function appendLineEl(line) {
  logEl.appendChild(lineEl(line));
  logEl.scrollTop = logEl.scrollHeight;
}

function renderLog(agent) {
  logEl.innerHTML = '';
  agent.lines.forEach(appendLineEl);
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Once a turn ends, fold its tool calls and in-between messages; the final answer stays visible.
function foldTurn(agent) {
  const L = agent.lines;
  const start = L.findLastIndex((l) => l.cls === 'you') + 1;
  const last = L.findLastIndex((l) => l.cls === 'assistant');
  const end = last >= start ? last : L.length;
  const inner = L.slice(start, end);
  const tools = inner.filter((l) => l.cls === 'tool').length;
  if (!tools) return;
  const msgs = inner.filter((l) => l.cls === 'assistant').length;
  L.splice(start, inner.length, { cls: 'fold', text: plural(tools, 'tool call') + (msgs ? ', ' + plural(msgs, 'message') : ''), lines: inner });
  if (state.active === agent.id) renderLog(agent);
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
      item.title = `${a.status} · ${branchLabel(a)}`;
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
  $('navCreate').classList.toggle('active', state.view === 'create');
  $('navSettings').classList.toggle('active', state.view === 'settings');
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

function showView(name) {
  state.view = name;
  for (const v of ['create', 'chat', 'settings']) $(v + 'View').hidden = v !== name;
  if (name !== 'chat') state.active = null;
  renderList();
}

function showCreate(ws) {
  showView('create');
  $('err').textContent = '';
  renderWorkspaceSelect(ws || $('ws').value);
  $('prompt').focus();
}

const branchLabel = (a) => a.branch || 'creating worktree…';

function setTitle(a) {
  $('title').querySelector('b').textContent = a.name;
  $('title').querySelector('small').textContent = `${basename(a.workspace)} · ${branchLabel(a)}`;
  // Same labels as the create form's dropdowns.
  const label = (id, v) => $(id).querySelector(`option[value="${v || ''}"]`)?.textContent ?? v;
  $('agentModel').textContent = `${label('model', a.model)} · ${label('effort', a.effort)}`;
}

async function select(id) {
  const a = state.agents.get(id);
  if (!a.lines) {
    // Restored after a restart: replay the saved transcript once.
    a.lines = [];
    for (const evt of await window.agents.history(id)) handleEvent(a, evt);
  }
  state.active = id;
  showView('chat');
  setTitle(a);
  renderLog(a);
  syncGo();
  input.focus();
}

// Turn one stream-json event into readable lines.
function handleEvent(agent, evt) {
  if (evt.type === 'you') {
    addLine(agent, 'you', '› ' + evt.text); // only in saved history; live messages are added on send
  } else if (evt.type === 'assistant') {
    for (const block of evt.message?.content ?? []) {
      if (block.type === 'text') addLine(agent, 'assistant', block.text);
      else if (block.type === 'tool_use')
        addLine(agent, 'tool', `🔧 ${block.name} ${JSON.stringify(block.input).slice(0, 200)}`);
    }
  } else if (evt.type === 'result') {
    foldTurn(agent);
    const cost = evt.total_cost_usd != null ? ` · $${evt.total_cost_usd.toFixed(4)}` : '';
    addLine(agent, 'meta', `done${cost}`);
    for (const d of evt.permission_denials ?? [])
      addLine(agent, 'meta', `⛔ denied: ${d.tool_name} ${JSON.stringify(d.tool_input).slice(0, 200)}`);
  } else if (evt.type === 'stderr' || evt.type === 'raw') {
    addLine(agent, 'meta', evt.text);
  }
}

$('navCreate').onclick = () => showCreate();

// ---- Settings ----
const PROVIDERS = { firstParty: 'Anthropic API', bedrock: 'Amazon Bedrock', vertex: 'Google Vertex AI', foundry: 'Microsoft Foundry' };
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function loginMethod(st) {
  if (st.authMethod === 'claude.ai') return st.subscriptionType ? `Claude ${cap(st.subscriptionType)} account` : 'Claude.ai account';
  return st.authMethod || '—';
}

async function refreshStatus() {
  $('stDot').className = 'dot';
  $('stText').textContent = 'Checking…';
  $('refresh').disabled = true;
  const st = await window.agents.status();
  $('refresh').disabled = false;
  const connected = st.ok && st.loggedIn;
  $('stDot').className = 'dot ' + (connected ? 'ok' : 'bad');
  $('stText').textContent = connected ? 'Connected' : st.ok ? 'Not logged in' : 'Not available';
  const rows = st.ok
    ? [['Version', st.version], ['Provider', PROVIDERS[st.apiProvider] || st.apiProvider], ['Login method', loginMethod(st)],
       ['Organization', st.orgName], ['Email', st.email]]
    : [];
  const table = $('stTable');
  table.innerHTML = '';
  table.hidden = !rows.length;
  for (const [k, v] of rows) {
    const tr = document.createElement('tr');
    tr.append(el('th', null, k), el('td', null, v || '—'));
    table.appendChild(tr);
  }
  $('stHint').className = st.ok ? 'meta' : 'meta bad-text';
  $('stHint').textContent = !st.ok ? st.error : connected ? '' : 'Run claude auth login in a terminal, then Refresh.';
  if (st.configDirectory) $('settingsFile').textContent = st.configDirectory.replace(/\/$/, '') + '/settings.json';
}

async function saveClaudePath(file) {
  const res = await window.agents.setClaudePath(file);
  $('pathMsg').className = res.error ? 'meta bad-text' : 'meta';
  $('pathMsg').textContent = res.error || (res.claudePath ? 'Saved.' : 'Using claude from PATH.');
  if (!res.error) { $('claudePath').value = res.claudePath; refreshStatus(); }
}

$('navSettings').onclick = async () => {
  showView('settings');
  $('pathMsg').textContent = '';
  $('claudePath').value = (await window.agents.settings()).claudePath;
  refreshStatus();
};
$('refresh').onclick = refreshStatus;
$('claudePath').onchange = () => saveClaudePath($('claudePath').value);
$('systemClaude').onclick = () => saveClaudePath('');
$('browse').onclick = async () => {
  const file = await window.agents.browseClaude();
  if (file) saveClaudePath(file);
};

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
  if (!confirm(`Remove agent "${agent.name}" and its worktree?${agent.branch ? ` The branch ${agent.branch} is kept.` : ''}`)) return;
  const res = await window.agents.remove(agent.id);
  if (!res.ok) { addLine(agent, 'meta', `Could not remove the worktree: ${res.error}`); return; }
  state.agents.delete(agent.id);
  if (state.active === agent.id) showCreate(agent.workspace);
  else renderList();
}

// Enter sends, Shift+Enter adds a new line, like the create form.
input.onkeydown = (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('form').requestSubmit(); }
};
const syncGo = () => { $('go').disabled = !input.value.trim(); };
input.oninput = syncGo;

$('form').onsubmit = async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  const agent = state.agents.get(state.active);
  if (!text || !agent) return;
  if (agent.status === 'setup') { addLine(agent, 'meta', 'Still setting up the worktree, try again in a moment.'); return; }
  input.value = '';
  syncGo();
  addLine(agent, 'you', '› ' + text);
  const ok = await window.agents.send(agent.id, text);
  if (!ok) addLine(agent, 'meta', 'Could not start the agent.');
};

window.agents.onEvent((id, evt) => {
  const a = state.agents.get(id);
  if (a?.lines) handleEvent(a, evt); // not loaded yet: the history will include it
});
window.agents.onInfo((info) => {
  const a = state.agents.get(info.id);
  if (!a) return;
  Object.assign(a, info);
  if (state.active === a.id) setTitle(a);
  renderList();
});
window.agents.onStatus((id, status) => {
  const a = state.agents.get(id);
  if (a) { a.status = status; renderList(); }
});

Promise.all([window.agents.workspaces(), window.agents.list()]).then(([ws, list]) => {
  state.workspaces = ws;
  for (const info of list) state.agents.set(info.id, { ...info, lines: null }); // history loads on select
  showCreate();
});
