/** Rovecode Mission Control — the /ui dashboard (F2, sdk-blueprint.md §5b).
 *
 *  ONE self-contained HTML document, no build step, no CDN: the serve command's
 *  hand-authored-OpenAPI tradition applied to the page. It reads GET /events (SSE)
 *  and /sessions, renders sessions, live run activity and the agent tree; it holds
 *  no state of its own beyond what the bus told it (render-only, §5 kuralı). */

export function dashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>rovecode · mission control</title>
<style>
  :root {
    --bg: #0b0e14; --panel: #12161f; --edge: #1f2633; --text: #d7dde8; --dim: #7d8698;
    --queued: #8a93a5; --running: #4da3ff; --done: #3ecf8e; --failed: #ff6b6b;
    --cancelled: #c9a227; --accent: #b48cff;
  }
  * { box-sizing: border-box; margin: 0; }
  body { background: var(--bg); color: var(--text); font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; height: 100vh; display: flex; flex-direction: column; }
  header { padding: 10px 16px; border-bottom: 1px solid var(--edge); display: flex; align-items: baseline; gap: 12px; }
  header h1 { font-size: 14px; font-weight: 600; letter-spacing: .04em; }
  header h1 em { color: var(--accent); font-style: normal; }
  #conn { color: var(--dim); font-size: 11px; }
  #conn.live { color: var(--done); }
  main { flex: 1; display: grid; grid-template-columns: 260px 1fr 320px; min-height: 0; }
  section { border-right: 1px solid var(--edge); overflow-y: auto; padding: 10px; }
  section:last-child { border-right: 0; }
  h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .12em; color: var(--dim); margin: 4px 2px 8px; }
  .sess { padding: 6px 8px; border: 1px solid var(--edge); border-radius: 6px; margin-bottom: 6px; cursor: pointer; background: var(--panel); }
  .sess.sel { border-color: var(--accent); }
  .sess .id { font-size: 11px; color: var(--dim); }
  .sess .st { float: right; font-size: 10px; }
  .ev { padding: 2px 6px; border-radius: 4px; white-space: pre-wrap; word-break: break-word; }
  .ev .t { color: var(--dim); margin-right: 6px; }
  .ev.run_start, .ev.run_end { background: var(--panel); }
  .ev.tool_execution_end .t { color: var(--running); }
  .node { padding: 5px 8px; border: 1px solid var(--edge); border-left-width: 3px; border-radius: 6px; margin: 4px 0; background: var(--panel); }
  .node .lbl { font-weight: 600; }
  .node .meta { font-size: 11px; color: var(--dim); }
  .st-queued { border-left-color: var(--queued); } .st-queued .badge { color: var(--queued); }
  .st-running { border-left-color: var(--running); } .st-running .badge { color: var(--running); }
  .st-done { border-left-color: var(--done); } .st-done .badge { color: var(--done); }
  .st-failed { border-left-color: var(--failed); } .st-failed .badge { color: var(--failed); }
  .st-cancelled { border-left-color: var(--cancelled); } .st-cancelled .badge { color: var(--cancelled); }
  .empty { color: var(--dim); padding: 8px; font-size: 12px; }
</style>
</head>
<body>
<header>
  <h1>rovecode <em>mission control</em></h1>
  <span id="conn">connecting…</span>
</header>
<main>
  <section><h2>Sessions</h2><div id="sessions"></div></section>
  <section><h2>Live events</h2><div id="feed"></div></section>
  <section><h2>Agent tree</h2><div id="tree"></div></section>
</main>
<script>
const $ = (id) => document.getElementById(id);
const state = { sessions: [], sel: null, trees: {}, running: {} };
const short = (id) => id.length > 8 ? id.slice(0, 8) : id;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function refreshSessions() {
  try {
    const r = await fetch("/sessions");
    const list = await r.json();
    state.sessions = (Array.isArray(list) ? list : []).map((s) => s.id ?? s);
  } catch { /* server restarting */ }
  renderSessions();
}

function renderSessions() {
  const el = $("sessions");
  if (state.sessions.length === 0) { el.innerHTML = '<div class="empty">no sessions yet</div>'; return; }
  el.innerHTML = state.sessions.map((id) => {
    const running = state.running[id] ? '<span class="st" style="color:var(--running)">● running</span>' : "";
    return '<div class="sess' + (state.sel === id ? " sel" : "") + '" data-id="' + esc(id) + '">' + running +
      '<div>' + esc(short(id)) + '</div><div class="id">' + esc(id) + '</div></div>';
  }).join("");
  for (const d of el.querySelectorAll(".sess")) d.onclick = () => { state.sel = d.dataset.id; renderSessions(); renderTree(); };
}

function renderTree() {
  const el = $("tree");
  const id = state.sel ?? state.sessions[0];
  const tree = (id && state.trees[id]) || [];
  if (tree.length === 0) { el.innerHTML = '<div class="empty">no subagents or background tasks yet</div>'; return; }
  const depthPad = (n) => "margin-left:" + Math.min(n.depth - 1, 6) * 14 + "px";
  el.innerHTML = tree.map((n) =>
    '<div class="node st-' + esc(n.status) + '" style="' + depthPad(n) + '">' +
    '<span class="badge">●</span> <span class="lbl">' + esc(n.label) + '</span>' +
    (n.isolated ? ' <span class="meta">[worktree]</span>' : "") +
    '<div class="meta">' + esc(n.agent) + " · depth " + n.depth + (n.parent ? " · ↑ " + esc(n.parent) : "") +
    (n.summary ? "<br>" + esc(n.summary) : "") + (n.error ? "<br>" + esc(n.error) : "") +
    "</div></div>"
  ).join("");
}

function feed(ev) {
  const el = $("feed");
  const d = document.createElement("div");
  d.className = "ev " + ev.type;
  let text = ev.type;
  if (ev.type === "run_start") text = "run start — " + (ev.goal || "").slice(0, 120);
  else if (ev.type === "run_end") text = "run end: " + ev.status + " — " + (ev.summary || "").slice(0, 160);
  else if (ev.type === "tool_execution_start") text = "→ " + ev.tool;
  else if (ev.type === "tool_execution_end") text = (ev.ok ? "✓ " : "✗ ") + ev.callId + " " + ev.durationMs + "ms";
  else if (ev.type === "compaction") text = "compaction " + ev.strategy + " " + ev.tokensBefore + "→" + ev.tokensAfter;
  d.innerHTML = '<span class="t">' + esc(ev.type) + '</span>' + esc(text === ev.type ? "" : text);
  el.appendChild(d);
  while (el.childElementCount > 400) el.removeChild(el.firstChild);
  el.scrollTop = el.scrollHeight;
}

function connect() {
  const es = new EventSource("/events");
  es.onopen = () => { $("conn").textContent = "live"; $("conn").className = "live"; };
  es.onerror = () => { $("conn").textContent = "reconnecting…"; $("conn").className = ""; };
  es.onmessage = (m) => {
    let msg; try { msg = JSON.parse(m.data); } catch { return; }
    if (msg.type === "hello") { for (const id of msg.sessions) if (!state.sessions.includes(id)) state.sessions.push(id); renderSessions(); }
    else if (msg.type === "session_created") { if (!state.sessions.includes(msg.sessionId)) state.sessions.push(msg.sessionId); renderSessions(); }
    else if (msg.type === "agent_tree_update") { state.trees[msg.sessionId] = msg.tree; renderTree(); }
    else if (msg.type === "run_event") {
      const ev = msg.event;
      if (ev.type === "run_start") state.running[msg.sessionId] = true;
      if (ev.type === "run_end") state.running[msg.sessionId] = false;
      renderSessions();
      if (!state.sel || state.sel === msg.sessionId) feed(ev);
    }
  };
}

refreshSessions();
setInterval(refreshSessions, 5000);
connect();
</script>
</body>
</html>`;
}
