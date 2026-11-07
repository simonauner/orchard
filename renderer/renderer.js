// agents: { id, name, status, branch, workspace, runs, lines: [{cls, text}] | null until loaded,
//          logs: { setup|run: [...] } (this run of the app only), running: {setup, run} }
// tab: the open tab of the right-hand script panel ('setup' | 'run' | 'terminal').
const state = { workspaces: [], hidden: [], hiddenOpen: false, agents: new Map(), active: null, view: 'create', tab: 'run' };

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

// The panel shows once the worktree exists.
const syncPanel = (a) => { $('panel').hidden = !a.branch; };

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
  if (line.cls === 'ask') return askEl(line);
  if (!line.lines) return el('div', 'msg ' + line.cls, line.text);
  const d = el('details', 'msg fold' + (line.live ? ' live' : ''));
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

// A permission request or AskUserQuestion from claude; it waits until the user answers here.
// line: { cls: 'ask', agentId, req: {request_id, tool_name, display_name, description, input}, done: null | text }
function askEl(line) {
  const { req } = line;
  const d = el('div', 'msg ask');
  const answer = async (ans, doneText) => {
    for (const b of d.querySelectorAll('button')) b.disabled = true;
    const ok = await window.agents.respond(line.agentId, req.request_id, ans);
    settleAsk(line, ok ? doneText : 'No longer pending (the agent was restarted or stopped).');
  };
  const buttons = el('div', 'askBtns');
  if (req.tool_name === 'AskUserQuestion') {
    const qs = req.input?.questions ?? [];
    const fields = qs.map((q, i) => {
      const box = el('fieldset');
      box.appendChild(el('legend', null, q.header ? `${q.header}: ${q.question}` : q.question));
      for (const o of q.options ?? []) {
        const lab = el('label');
        const inp = el('input');
        inp.type = q.multiSelect ? 'checkbox' : 'radio';
        inp.name = `${req.request_id}-${i}`;
        inp.value = o.label;
        lab.append(inp, el('b', null, o.label), o.description ? el('span', 'meta', ` ${o.description}`) : '');
        box.appendChild(lab);
      }
      const other = el('input');
      other.placeholder = 'Other…';
      box.appendChild(other);
      d.appendChild(box);
      // Other text wins over a picked option for single-choice questions.
      return () => {
        const picked = [...box.querySelectorAll('input:checked')].map((x) => x.value);
        const text = other.value.trim();
        return q.multiSelect ? [...picked, text].filter(Boolean).join(', ') : text || picked[0] || '';
      };
    });
    const send = el('button', 'btn primary', 'Send answer');
    send.onclick = () => {
      const answers = Object.fromEntries(qs.map((q, i) => [q.question, fields[i]()]));
      if (Object.values(answers).some((a) => !a)) return alert('Answer every question first.');
      answer({ allow: true, answers }, 'Answered: ' + Object.values(answers).join(' · '));
    };
    const skip = el('button', 'btn', 'Skip');
    skip.onclick = () => answer({ allow: false, message: 'The user skipped the question.' }, 'Skipped');
    buttons.append(send, skip);
  } else {
    d.appendChild(el('b', null, `Claude wants to use ${req.display_name || req.tool_name}`));
    if (req.description) d.appendChild(el('div', 'meta', req.description));
    d.appendChild(el('pre', null, req.input?.command ?? JSON.stringify(req.input, null, 2)));
    const allow = el('button', 'btn primary', 'Allow');
    allow.onclick = () => answer({ allow: true }, 'Allowed');
    const deny = el('button', 'btn', 'Deny');
    deny.onclick = () => answer({ allow: false }, 'Denied');
    buttons.append(allow, deny);
  }
  if (line.done) {
    for (const x of d.querySelectorAll('input')) x.disabled = true;
    d.appendChild(el('div', 'meta', line.done));
  } else d.appendChild(buttons);
  return d;
}

function settleAsk(line, done) {
  line.done ||= done;
  const a = state.agents.get(line.agentId);
  if (a && state.active === a.id) renderLog(a);
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// While a turn runs, its tool calls and messages go into one fold whose summary shows the latest line.
function addTurnLine(agent, cls, text) {
  const L = agent.lines;
  let fold = L.at(-1);
  if (!fold?.live) L.push(fold = { cls: 'fold', live: true, lines: [] });
  fold.lines.push({ cls, text });
  fold.text = text.split('\n')[0];
  if (state.active !== agent.id) return;
  const old = logEl.lastElementChild;
  if (old?.classList.contains('live')) {
    const d = lineEl(fold);
    d.open = old.open;
    old.replaceWith(d);
    logEl.scrollTop = logEl.scrollHeight;
  } else appendLineEl(fold);
}

// Once a turn ends, settle its fold: the final answer moves out, and a fold without tool calls opens up.
function foldTurn(agent) {
  agent.lines = agent.lines.flatMap((l) => {
    if (!l.live) return [l];
    const inner = l.lines;
    const answer = inner.at(-1)?.cls === 'assistant' ? [inner.pop()] : [];
    const tools = inner.filter((x) => x.cls === 'tool').length;
    if (!tools) return [...inner, ...answer];
    const msgs = inner.length - tools;
    return [{ cls: 'fold', text: plural(tools, 'tool call') + (msgs ? ', ' + plural(msgs, 'message') : ''), lines: inner }, ...answer];
  });
  if (state.active === agent.id) renderLog(agent);
}

const ARCHIVE_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/></svg>';

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function renderWorkspace(ws, target) {
  const isHidden = state.hidden.includes(ws);
  const head = el('div', 'ws');
  head.title = ws;
  head.appendChild(el('span', 'name', basename(ws)));
  const more = el('button', 'icon more', '⋯');
  more.title = more.ariaLabel = `Options for ${basename(ws)}`;
  more.onclick = (e) => { e.stopPropagation(); openMenu(more, [
    [isHidden ? 'Show repository' : 'Hide repository', () => setHidden(ws, !isHidden)],
    ['Remove repository', () => removeWorkspace(ws), 'danger'],
  ]); };
  const plus = el('button', 'icon', '+');
  plus.title = plus.ariaLabel = `New agent in ${basename(ws)}`;
  plus.onclick = () => showCreate(ws);
  head.append(more, plus);
  target.appendChild(head);

  for (const a of state.agents.values()) {
    if (a.workspace !== ws) continue;
    const item = el('div', 'item' + (a.id === state.active ? ' active' : ''));
    item.title = `${a.status} · ${branchLabel(a)}`;
    item.appendChild(el('span', `dot ${a.status}`));
    item.appendChild(el('span', 'name', a.name));
    const rm = el('button', 'icon rm');
    rm.innerHTML = ARCHIVE_ICON;
    rm.title = rm.ariaLabel = 'Archive workspace';
    rm.onclick = (e) => { e.stopPropagation(); remove(a); };
    item.appendChild(rm);
    item.onclick = () => select(a.id);
    target.appendChild(item);
  }
}

// The first nine visible agents get the number that ⌘1–9 jumps to.
function numberItems() {
  let n = 0;
  for (const d of listEl.querySelectorAll('.item .dot')) { // on the dot itself: CSS attr() only reads its own element
    if (d.offsetParent && n < 9) d.dataset.n = ++n;
    else delete d.dataset.n;
  }
}

function renderList() {
  listEl.innerHTML = '';
  if (!state.workspaces.length) listEl.appendChild(el('div', 'hint', 'Add a git repo with + to get started.'));
  for (const ws of state.workspaces) if (!state.hidden.includes(ws)) renderWorkspace(ws, listEl);
  if (state.hidden.length) {
    const box = el('details', 'hiddenWs');
    box.open = state.hiddenOpen;
    box.ontoggle = () => { state.hiddenOpen = box.open; numberItems(); };
    box.appendChild(el('summary', null, `Hidden workspaces (${state.hidden.length})`));
    for (const ws of state.hidden) renderWorkspace(ws, box);
    listEl.appendChild(box);
  }
  numberItems();
  $('navCreate').classList.toggle('active', state.view === 'create');
  $('navSettings').classList.toggle('active', state.view === 'settings');
}

// A small popup menu under `anchor`; items: [label, action, cls?]. Closes on any click or Escape.
function openMenu(anchor, items) {
  closeMenu();
  const menu = el('div', 'menu');
  menu.id = 'menu';
  menu.setAttribute('role', 'menu');
  for (const [label, action, cls] of items) {
    const b = el('button', cls, label);
    b.setAttribute('role', 'menuitem');
    b.onclick = () => { closeMenu(); action(); };
    menu.appendChild(b);
  }
  const r = anchor.getBoundingClientRect();
  Object.assign(menu.style, { top: `${r.bottom + 4}px`, left: `${r.left}px` });
  document.body.appendChild(menu);
  menu.firstChild.focus();
}
const closeMenu = () => $('menu')?.remove();
document.addEventListener('click', (e) => { if (!e.target.closest('#menu')) closeMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

async function setHidden(ws, hide) {
  state.hidden = await window.agents.setHidden(ws, hide);
  if (hide) state.hiddenOpen = false;
  renderList();
}

async function removeWorkspace(ws) {
  if (!confirm(`Remove ${basename(ws)} from Orchard? The repo on disk is not touched.`)) return;
  const res = await window.agents.removeWorkspace(ws);
  if (res.error) { alert(res.error); return; }
  Object.assign(state, res);
  if (state.view === 'create') showCreate();
  else renderList();
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
  renderQueue(a);
  syncBusy(a);
  showTab(state.tab);
  renderGit(a);
  refreshGit(id);
  if (state.tab !== 'terminal') input.focus();
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
  $('out').hidden = tab === 'terminal';
  $('term').hidden = tab !== 'terminal';
  if (tab === 'terminal') showTerm(a);
  else renderOut(a);
}

// ---- Terminal tab: one xterm showing the open agent's shell, which lives in main ----
// termFor: the agent whose shell the xterm shows; null while (re)loading, so no output is written twice.
let xterm = null, fit = null, termFor = null;

async function showTerm(a) {
  if (!a.branch) return; // no worktree yet
  if (!xterm) {
    const light = !matchMedia('(prefers-color-scheme: dark)').matches;
    xterm = new Terminal({ fontFamily: 'ui-monospace, monospace', fontSize: 12, cursorBlink: true,
      theme: light ? { background: '#ffffff', foreground: '#111111', cursor: '#111111', selectionBackground: '#0003' } : {} });
    fit = new FitAddon.FitAddon();
    xterm.loadAddon(fit);
    xterm.open($('term'));
    xterm.onData((d) => termFor && window.agents.termInput(termFor, d));
    xterm.onResize(({ cols, rows }) => termFor && window.agents.termResize(termFor, cols, rows));
    new ResizeObserver(() => { if (!$('term').hidden) fit.fit(); }).observe($('term'));
  }
  fit.fit();
  if (termFor !== a.id) {
    termFor = null;
    xterm.reset();
    const scrollback = await window.agents.termOpen(a.id, xterm.cols, xterm.rows);
    if (state.active !== a.id || state.tab !== 'terminal' || scrollback == null) return; // switched away meanwhile
    termFor = a.id;
    xterm.write(scrollback);
    window.agents.termResize(a.id, xterm.cols, xterm.rows); // a reopened shell may have another size
  }
  xterm.focus();
}

window.agents.onTermData((id, data) => { if (id === termFor) xterm.write(data); });
window.agents.onTermExit((id) => {
  if (id !== termFor) return;
  termFor = null;
  xterm.write('\r\n[shell exited, click Terminal to start a new one]\r\n');
});

// While a run script is going: Stop, and "Open :port" once it has printed a localhost URL.
function syncRunBtns(a) {
  $('runBtn').textContent = a.running.run ? '■ Stop ⌘R' : '▶ Run ⌘R';
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

// ---- Git panel: the worktree's PRs and changes ----
async function refreshGit(id) {
  const info = await window.agents.git(id);
  const a = state.agents.get(id);
  if (!a || !info) return;
  a.git = info;
  if (state.active === id && state.view === 'chat') renderGit(a);
}

const STATUS_CLS = { 'Ready to merge': 'ok', Merged: 'merged', 'Checks failing': 'bad', Conflicts: 'bad', 'Changes requested': 'bad' };

function renderGit(a) {
  const g = a.git;
  const prs = $('prs'), files = $('files');
  prs.innerHTML = files.innerHTML = '';
  $('filesSum').textContent = '';
  if (!g) return;
  if (g.ghError) prs.appendChild(el('div', 'meta', g.ghError));
  for (const pr of g.prs) {
    const row = el('div', 'pr');
    const link = el('a', 'btn ' + (STATUS_CLS[pr.status] || ''), `#${pr.number} ↗`);
    link.href = pr.url;
    link.target = '_blank';
    link.title = pr.title;
    row.appendChild(link);
    if (pr.deploymentUrl) {
      const dep = el('a', 'btn', '🌐 View deployment');
      dep.href = pr.deploymentUrl;
      dep.target = '_blank';
      row.appendChild(dep);
    }
    row.appendChild(el('span', 'status ' + (STATUS_CLS[pr.status] || ''), pr.status));
    if (!['Merged', 'Closed', 'Draft'].includes(pr.status)) {
      const merge = el('button', 'btn', 'Merge');
      merge.onclick = async () => {
        if (!confirm(`Merge #${pr.number} "${pr.title}"?`)) return;
        merge.disabled = true;
        const res = await window.agents.merge(a.id, pr.number);
        if (res.error) addLine(a, 'meta', `Could not merge #${pr.number}: ${res.error}`);
        refreshGit(a.id);
      };
      row.appendChild(merge);
    }
    prs.appendChild(row);
  }
  if (g.diffError) { files.appendChild(el('div', 'meta', g.diffError)); return; }
  const sum = (k) => g.files.reduce((n, f) => n + (f[k] || 0), 0);
  $('filesSum').textContent = `${plural(g.files.length, 'file')} changed`;
  const totals = el('span', 'meta', ` vs ${g.base} `);
  totals.append(el('span', 'add', `+${sum('add')}`), ' ', el('span', 'del', `-${sum('del')}`));
  $('filesSum').appendChild(totals);
  for (const f of g.files) {
    const row = el('div', 'file');
    row.title = f.file;
    row.appendChild(el('span', 'path', f.file));
    if (f.untracked) row.appendChild(el('span', 'add', 'new'));
    else if (f.add == null) row.appendChild(el('span', 'meta', 'binary'));
    else row.append(el('span', 'add', `+${f.add}`), el('span', 'del', `-${f.del}`));
    files.appendChild(row);
  }
}

$('gitRefresh').onclick = () => state.active && refreshGit(state.active);
// shortcut: polls the open agent every 30s for CI/review changes; use GitHub webhooks if that gets too chatty.
setInterval(() => { if (state.active && state.view === 'chat' && !document.hidden) refreshGit(state.active); }, 30000);

// Turn one stream-json event into readable lines.
function handleEvent(agent, evt) {
  if (evt.type === 'system' && evt.subtype === 'init' && evt.model) {
    agent.liveModel = evt.model;
    if (state.active === agent.id) setTitle(agent);
  } else if (evt.type === 'you') {
    addLine(agent, 'you', withImages(evt.text, evt.images)); // only in saved history; live messages are added on send
  } else if (evt.type === 'assistant') {
    for (const block of evt.message?.content ?? []) {
      if (block.type === 'text') addTurnLine(agent, 'assistant', block.text);
      else if (block.type === 'tool_use')
        addTurnLine(agent, 'tool', `🔧 ${block.name} ${JSON.stringify(block.input).slice(0, 200)}`);
    }
  } else if (evt.type === 'result') {
    foldTurn(agent);
    const cost = evt.total_cost_usd != null ? ` · $${evt.total_cost_usd.toFixed(4)}` : '';
    addLine(agent, 'meta', `done${cost}`);
    for (const d of evt.permission_denials ?? [])
      addLine(agent, 'meta', `⛔ denied: ${d.tool_name} ${JSON.stringify(d.tool_input).slice(0, 200)}`);
  } else if (evt.type === 'control_request') {
    const line = { cls: 'ask', agentId: agent.id, req: { request_id: evt.request_id, ...evt.request }, done: null };
    agent.lines.push(line);
    if (state.active === agent.id) appendLineEl(line);
  } else if (evt.type === 'control_answer' || evt.type === 'control_cancel_request') {
    const line = agent.lines.find((l) => l.cls === 'ask' && l.req.request_id === evt.request_id);
    const ans = evt.answers && Object.values(evt.answers).join(' · ');
    if (line) settleAsk(line, evt.type === 'control_cancel_request' ? 'Cancelled by the agent' : ans ? `Answered: ${ans}` : evt.behavior === 'allow' ? 'Allowed' : 'Denied');
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

// Drop images (sent as image blocks) or text files like .txt/.json (pasted into the message) on a form.
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const TEXT_EXT = /\.(txt|json|md|csv|log|ya?ml|xml)$/i;
const MAX_IMAGE = 3.75 * 1024 * 1024; // the API caps an image at 5 MB of base64
const MAX_TEXT = 1024 * 1024;
const pending = { promptFiles: [], textFiles: [] }; // images waiting to be sent, per form

// Electron would otherwise open a file dropped anywhere in the window.
for (const t of ['dragover', 'drop']) document.addEventListener(t, (e) => e.preventDefault());

function renderChips(id) {
  const box = $(id);
  box.innerHTML = '';
  pending[id].forEach((img, i) => {
    const chip = el('span', 'chip');
    const thumb = el('img');
    thumb.src = `data:${img.media_type};base64,${img.data}`;
    thumb.alt = '';
    const rm = el('button', 'icon', '×');
    rm.type = 'button';
    rm.title = rm.ariaLabel = `Remove ${img.name}`;
    rm.onclick = () => { pending[id].splice(i, 1); renderChips(id); syncGo(); };
    chip.append(thumb, el('span', null, img.name), rm);
    box.appendChild(chip);
  });
}

function insertText(area, text) {
  const at = area.selectionEnd ?? area.value.length;
  area.value = area.value.slice(0, at) + text + area.value.slice(at);
  area.selectionStart = area.selectionEnd = at + text.length;
}

async function addFiles(files, area, chipsId) {
  const skipped = [];
  for (const file of files) {
    if (IMAGE_TYPES.includes(file.type) && file.size <= MAX_IMAGE) {
      const url = await new Promise((ok, fail) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = fail; r.readAsDataURL(file); });
      pending[chipsId].push({ name: file.name, media_type: file.type, data: url.slice(url.indexOf(',') + 1) });
    } else if ((file.type.startsWith('text/') || file.type === 'application/json' || TEXT_EXT.test(file.name)) && file.size <= MAX_TEXT) {
      insertText(area, `${area.value && !area.value.endsWith('\n') ? '\n' : ''}${file.name}:\n\`\`\`\n${(await file.text()).trimEnd()}\n\`\`\`\n`);
    } else skipped.push(file.name);
  }
  renderChips(chipsId);
  syncGo();
  area.focus();
  if (skipped.length) alert(`Not added (only images up to 3.75 MB and text files up to 1 MB):\n\n${skipped.join('\n')}`);
}

// Files can be dropped anywhere on the middle panel; the overlay shows that while files are dragged over the window.
const dropZone = () => (state.view === 'chat' ? $('chatCol') : state.view === 'create' ? document.querySelector('main') : null);
const overlay = $('dropOverlay');
function inZone(e) {
  const r = dropZone()?.getBoundingClientRect();
  return !!r && e.clientX >= r.left && e.clientX < r.right && e.clientY >= r.top && e.clientY < r.bottom;
}
document.addEventListener('dragover', (e) => {
  const zone = dropZone();
  if (!zone || !e.dataTransfer.types.includes('Files')) return;
  const r = zone.getBoundingClientRect();
  Object.assign(overlay.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  overlay.hidden = false;
  overlay.classList.toggle('over', inZone(e));
  e.dataTransfer.dropEffect = inZone(e) ? 'copy' : 'none';
});
document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) overlay.hidden = true; }); // left the window
document.addEventListener('drop', (e) => {
  overlay.hidden = true;
  if (!inZone(e)) return;
  if (state.view === 'chat') addFiles(e.dataTransfer.files, input, 'textFiles');
  else addFiles(e.dataTransfer.files, $('prompt'), 'promptFiles');
});

function syncGo() { $('go').disabled = !input.value.trim() && !pending.textFiles.length; }
input.oninput = syncGo;

$('form').onsubmit = async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  const images = pending.textFiles;
  const agent = state.agents.get(state.active);
  if ((!text && !images.length) || !agent) return;
  input.value = '';
  pending.textFiles = [];
  renderChips('textFiles');
  syncGo();
  if (['working', 'waiting', 'setup'].includes(agent.status)) { (agent.queue ??= []).push({ text, images }); renderQueue(agent); }
  else sendNow(agent, { text, images });
};

async function sendNow(agent, { text, images }) {
  agent.status = 'working'; // before main's status event arrives, so a quick second message is queued too
  syncBusy(agent);
  addLine(agent, 'you', withImages(text, images.map((i) => i.name)));
  const ok = await window.agents.send(agent.id, text, images);
  if (!ok) addLine(agent, 'meta', 'Could not start the agent.');
}

// Shows the agent is busy, so a long tool call doesn't look like the app hung. 'waiting' is on the user.
function syncBusy(a) {
  if (state.active === a.id) $('busy').hidden = !['working', 'setup'].includes(a.status);
}

// Messages sent while the agent works wait here and go out one per finished turn.
function renderQueue(a) {
  if (state.active !== a.id) return;
  const box = $('queue');
  box.innerHTML = '';
  (a.queue ?? []).forEach(({ text, images }, i) => {
    const row = el('div', 'queued');
    row.appendChild(el('span', 'name', withImages(text, images.map((img) => img.name))));
    const rm = el('button', 'icon', '×');
    rm.title = rm.ariaLabel = 'Remove queued message';
    rm.onclick = () => { a.queue.splice(i, 1); renderQueue(a); };
    row.appendChild(rm);
    box.appendChild(row);
  });
  box.hidden = !box.childElementCount;
}

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
  if (!a) return;
  a.status = status;
  syncBusy(a);
  if (status === 'done' && a.queue?.length) { sendNow(a, a.queue.shift()); renderQueue(a); }
  renderList();
  if (status === 'done') refreshGit(id); // the agent may have committed or opened a PR
});

Promise.all([window.agents.workspaces(), window.agents.list()]).then(([ws, list]) => {
  Object.assign(state, ws);
  for (const info of list) state.agents.set(info.id, { ...info, lines: null, logs: { setup: [], run: [] }, running: {} }); // history loads on select
  showCreate();
});

// Drag the edge of the sidebar or the right panel to resize it; min/max come from the CSS.
for (const handle of document.querySelectorAll('.resizer')) {
  const pane = handle.parentElement, sign = pane.id === 'panel' ? -1 : 1, key = `width:${pane.id}`;
  const clamp = (w) => { const cs = getComputedStyle(pane); return Math.min(parseFloat(cs.maxWidth), Math.max(parseFloat(cs.minWidth), w)); };
  try { const saved = localStorage.getItem(key); if (saved) pane.style.width = `${saved}px`; } catch {}
  handle.addEventListener('pointerdown', (e) => {
    const startX = e.clientX, startW = pane.getBoundingClientRect().width;
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('dragging'); document.body.classList.add('resizing');
    const move = (ev) => { pane.style.width = `${clamp(startW + sign * (ev.clientX - startX))}px`; };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.classList.remove('dragging'); document.body.classList.remove('resizing');
      if (pane.style.width) try { localStorage.setItem(key, parseFloat(pane.style.width)); } catch {}
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up, { once: true });
  });
}

// Keyboard shortcuts. Capture phase, so xterm and textareas don't swallow them; preventDefault also stops the default menu's Cmd+R reload.
let cmdTimer = null;
const hideNums = () => { clearTimeout(cmdTimer); cmdTimer = null; document.body.classList.remove('showNums'); };
window.addEventListener('keydown', (e) => {
  if (e.key === 'Meta') { if (!cmdTimer) cmdTimer = setTimeout(() => document.body.classList.add('showNums'), 500); return; }
  if (!/^[1-9]$/.test(e.key)) hideNums(); // ⌘C and friends shouldn't flash the numbers
  if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
  const k = e.key.toLowerCase();
  if (k === 'r') {
    if (state.view === 'chat' && !$('runBtn').hidden) $('runBtn').click();
  } else if (k === 'l') {
    (state.view === 'chat' ? input : $('prompt')).focus();
  } else if (k === 'n') {
    showCreate(state.agents.get(state.active)?.workspace);
  } else if (/^[1-9]$/.test(k)) {
    listEl.querySelector(`.dot[data-n="${k}"]`)?.closest('.item').click();
  } else return;
  e.preventDefault();
}, true);
window.addEventListener('keyup', (e) => { if (e.key === 'Meta') hideNums(); });
window.addEventListener('blur', hideNums);
