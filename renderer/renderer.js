// agents: { id, name, status, branch, workspace, runs, lines: [{cls, text}] | null until loaded,
//          logs: { setup|run: [...] } (this run of the app only), running: {setup, run} }
// tab: the open tab of the right-hand script panel ('setup' | 'run').
const state = { workspaces: [], agents: new Map(), active: null, view: 'create', tab: 'run' };

const $ = (id) => document.getElementById(id);
const listEl = $('list'), logEl = $('log'), outEl = $('out'), input = $('text');
const basename = (p) => p.split('/').filter(Boolean).pop();

const tabLines = (a, tab) => (tab === 'chat' ? a.lines : a.logs[tab]);

function addLine(agent, cls, text, tab = 'chat') {
  tabLines(agent, tab).push({ cls, text });
  if (state.active !== agent.id) return;
  if (tab === 'chat') appendLineEl({ cls, text });
  else { syncPanel(agent); if (state.tab === tab) appendLineEl({ cls, text }, outEl); }
}

// The panel only takes room when the repo has scripts or something was printed (e.g. a config error).
const syncPanel = (a) => { $('panel').hidden = !a.configFile && !a.logs.setup.length && !a.logs.run.length; };

// Agent output is untrusted: show raw HTML as text instead of rendering it.
const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
marked.use({ renderer: { html: ({ text }) => escapeHtml(text) } });

const COPY_ICON = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="5" y="5" width="9" height="9" rx="2"/><path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5"/></svg>';

function copyButton(label, html, write) {
  const b = el('button', 'icon');
  b.title = b.ariaLabel = label;
  b.innerHTML = html;
  b.onclick = async () => {
    await write();
    b.innerHTML = '✓';
    setTimeout(() => (b.innerHTML = html), 1200);
  };
  return b;
}

// Assistant text rendered as markdown, with hover buttons to copy it formatted or as markdown.
function assistantEl(text) {
  const d = el('div', 'msg assistant');
  const body = el('div', 'md');
  body.innerHTML = marked.parse(text);
  const actions = el('div', 'actions');
  actions.append(
    copyButton('Copy', COPY_ICON, () => window.agents.copy({ html: body.innerHTML, text: body.innerText })),
    copyButton('Copy as markdown', 'MD', () => window.agents.copy({ text })),
  );
  d.append(body, actions);
  return d;
}

function lineEl(line) {
  if (line.cls === 'assistant') return assistantEl(line.text);
  if (!line.lines) return el('div', 'msg ' + line.cls, line.text);
  const d = el('details', 'msg fold');
  d.appendChild(el('summary', null, line.text));
  for (const l of line.lines) d.appendChild(lineEl(l));
  return d;
}

function appendLineEl(line, target = logEl) {
  target.appendChild(lineEl(line));
  target.scrollTop = target.scrollHeight;
}

// Renders the chat; the tool-call folding re-renders through here too.
function renderLog(agent) {
  logEl.innerHTML = '';
  agent.lines.forEach((l) => appendLineEl(l));
}

// Renders the open tab of the script panel.
function renderOut(agent) {
  outEl.innerHTML = '';
  const lines = agent.logs[state.tab];
  lines.forEach((l) => appendLineEl(l, outEl));
  if (!lines.length)
    appendLineEl({ cls: 'meta', text: agent.configFile ? `Nothing yet. Scripts come from ${agent.configFile}.`
      : 'No scripts. Add .orchard/settings.toml (or .conductor/settings.toml) to the repo.' }, outEl);
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
  showDefaults();
  $('prompt').focus();
}

// Same labels as the create form's dropdowns; unknown values (e.g. a full model id) as they are.
const optionText = (id, v) => [...$(id).options].find((o) => o.value === v)?.textContent ?? v;
const defaultText = (id, v) => `Default ${id}` + (v ? ` (${optionText(id, v)})` : '');
const choiceText = (id, v, def) => (v ? optionText(id, v) : defaultText(id, def));

async function showDefaults() {
  const ws = $('ws').value;
  const d = await window.agents.defaults(ws);
  if (ws !== $('ws').value) return; // the workspace changed while reading
  $('model').options[0].textContent = defaultText('model', d.model);
  $('effort').options[0].textContent = defaultText('effort', d.effort);
}
$('ws').onchange = showDefaults;

const branchLabel = (a) => a.branch || 'creating worktree…';

function setTitle(a) {
  $('title').querySelector('b').textContent = a.name;
  $('title').querySelector('small').textContent = `${basename(a.workspace)} · ${branchLabel(a)}`;
  // The model claude reported at start beats our guess from the settings files.
  const model = a.liveModel ? optionText('model', a.liveModel) : choiceText('model', a.model, a.defaults?.model);
  $('agentModel').textContent = `${model} · ${choiceText('effort', a.effort, a.defaults?.effort)}`;
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
  const sel = $('runSel');
  sel.innerHTML = '';
  for (const r of a.runs) {
    const o = el('option', null, r.name);
    o.value = r.name;
    sel.appendChild(o);
  }
  sel.value = a.runChoice || a.runs.find((r) => r.default)?.name || a.runs[0]?.name || '';
  syncGo();
  renderLog(a);
  showTab(state.tab);
  input.focus();
}

function showTab(tab) {
  state.tab = tab;
  const a = state.agents.get(state.active);
  for (const b of document.querySelectorAll('.tabBtn')) {
    b.classList.toggle('active', b.dataset.tab === tab);
    b.classList.toggle('running', !!a.running[b.dataset.tab]);
  }
  $('runBtn').hidden = !a.runs.length;
  syncRunBtns(a);
  syncPanel(a);
  renderOut(a);
}

// While a run script is going: Stop, and "Open :port" once it has printed a localhost URL.
function syncRunBtns(a) {
  $('runBtn').textContent = a.running.run ? '■ Stop' : '▶ Run';
  $('runSel').hidden = !a.runs.length || !!a.running.run; // makes room for Open while running
  $('openBtn').hidden = !a.running.run || !a.openUrl;
  if (!a.openUrl) return;
  $('openBtn').href = a.openUrl;
  $('openBtn').textContent = `🌐 Open :${new URL(a.openUrl).port}`;
}

// Like Conductor: the first localhost URL a run script prints is the one to open.
const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1):\d+\S*/;

for (const b of document.querySelectorAll('.tabBtn')) b.onclick = () => showTab(b.dataset.tab);
$('runSel').onchange = () => { state.agents.get(state.active).runChoice = $('runSel').value; };
$('runBtn').onclick = () => {
  const a = state.agents.get(state.active);
  if (a.running.run) window.agents.runStop(a.id);
  else { window.agents.run(a.id, $('runSel').value); showTab('run'); }
};

// Turn one stream-json event into readable lines.
function handleEvent(agent, evt) {
  if (evt.type === 'system' && evt.subtype === 'init' && evt.model) {
    agent.liveModel = evt.model;
    if (state.active === agent.id) setTitle(agent);
  } else if (evt.type === 'you') {
    addLine(agent, 'you', evt.text); // only in saved history; live messages are added on send
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
    const agent = { ...info, lines: [], logs: { setup: [], run: [] }, running: {} };
    state.tab = 'setup'; // setup starts next to the agent
    state.agents.set(info.id, agent);
    addLine(agent, 'you', prompt);
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
  addLine(agent, 'you', text);
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
  if (state.active === a.id) select(a.id); // the run scripts are known once the worktree exists
  renderList();
});
window.agents.onScript((id, kind, line) => {
  const a = state.agents.get(id);
  if (!a) return;
  addLine(a, 'out', line, kind);
  const url = kind === 'run' && !a.openUrl && line.match(LOCAL_URL)?.[0];
  if (url) { a.openUrl = url; if (state.active === id) syncRunBtns(a); }
});
window.agents.onScriptState((id, kind, running) => {
  const a = state.agents.get(id);
  if (!a) return;
  a.running[kind] = running;
  if (kind === 'run' && running) a.openUrl = null; // a new run announces its own URL
  if (state.active === id && state.view === 'chat') {
    document.querySelector(`.tabBtn[data-tab="${kind}"]`).classList.toggle('running', running);
    syncRunBtns(a);
  }
});
window.agents.onStatus((id, status) => {
  const a = state.agents.get(id);
  if (a) { a.status = status; renderList(); }
});

Promise.all([window.agents.workspaces(), window.agents.list()]).then(([ws, list]) => {
  state.workspaces = ws;
  for (const info of list) state.agents.set(info.id, { ...info, lines: null, logs: { setup: [], run: [] }, running: {} }); // history loads on select
  showCreate();
});
