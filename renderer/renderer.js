// agents: { id, name, status, lines: [{cls, text}] }
const state = { agents: new Map(), active: null };

const $ = (id) => document.getElementById(id);
const listEl = $('list'), logEl = $('log'), form = $('form'), input = $('text'), go = $('go');

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

function renderList() {
  listEl.innerHTML = '';
  for (const a of state.agents.values()) {
    const el = document.createElement('div');
    el.className = 'item' + (a.id === state.active ? ' active' : '');
    el.innerHTML = `<button class="rm" title="Remove agent and worktree" aria-label="Remove agent">×</button><span class="dot ${a.status}"></span><b></b><small></small>`;
    el.querySelector('b').textContent = a.name;
    el.querySelector('small').textContent = `${a.status} · ${a.branch}`;
    el.querySelector('.rm').onclick = (e) => { e.stopPropagation(); remove(a); };
    el.onclick = () => select(a.id);
    listEl.appendChild(el);
  }
}

function select(id) {
  state.active = id;
  const a = state.agents.get(id);
  logEl.innerHTML = '';
  a.lines.forEach(appendLineEl);
  input.disabled = go.disabled = false;
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

$('newForm').onsubmit = async (e) => {
  e.preventDefault();
  $('err').textContent = '';
  const info = await window.agents.create($('task').value);
  if (!info) return;
  if (info.error) { $('err').textContent = info.error; return; }
  $('task').value = '';
  state.agents.set(info.id, { ...info, lines: [] });
  select(info.id);
};

async function remove(agent) {
  if (!confirm(`Remove agent "${agent.name}" and its worktree? The branch ${agent.branch} is kept.`)) return;
  const res = await window.agents.remove(agent.id);
  if (!res.ok) { addLine(agent, 'meta', `Could not remove the worktree: ${res.error}`); return; }
  state.agents.delete(agent.id);
  if (state.active === agent.id) {
    state.active = null;
    logEl.innerHTML = '';
    input.disabled = go.disabled = true;
  }
  renderList();
}

form.onsubmit = async (e) => {
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
