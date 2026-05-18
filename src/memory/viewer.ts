// budget-aware-mcp — Memory + Code Graph Viewer
// Self-contained web UI served on localhost
// Think Obsidian graph view but for code knowledge
//
// Features:
// - Memory objects as cards (searchable, filterable by type)
// - Code graph visualization (symbols + edges)
// - Linked view: click a memory → see connected symbols
// - Stats dashboard (staleness, access frequency, type distribution)
// - Dark theme by default

import http from "http";
import { MemoryStore } from "./store.js";
import { db } from "../db.js";

const VIEWER_PORT = 4321;

export function startViewer(memoryStore: MemoryStore, rootDir?: string): http.Server {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${VIEWER_PORT}`);

    // CORS headers for all API responses
    const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

    // API endpoints
    if (url.pathname === "/api/memory") {
      res.writeHead(200, headers);
      const objects = memoryStore.all();
      res.end(JSON.stringify({ objects, stats: memoryStore.stats() }));
      return;
    }

    if (url.pathname === "/api/graph") {
      res.writeHead(200, headers);
      try {
        const dbInst = db.instance;
        const symbols = dbInst.prepare("SELECT name, fqn, kind, file_path FROM symbols LIMIT 200").all();
        const edges = dbInst.prepare("SELECT source_fqn, target_fqn, kind FROM edges LIMIT 500").all();
        res.end(JSON.stringify({ symbols, edges }));
      } catch (e: any) {
        res.end(JSON.stringify({ symbols: [], edges: [], error: e.message }));
      }
      return;
    }

    if (url.pathname === "/api/stats") {
      res.writeHead(200, headers);
      try {
        const dbInst = db.instance;
        const repos = dbInst.prepare("SELECT name, file_count, symbol_count, total_loc FROM repositories").all();
        const memStats = memoryStore.stats();
        res.end(JSON.stringify({ repos, memory: memStats }));
      } catch (e: any) {
        res.end(JSON.stringify({ repos: [], memory: memoryStore.stats(), error: e.message }));
      }
      return;
    }

    // Serve the viewer HTML
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(VIEWER_HTML);
  });

  server.listen(VIEWER_PORT, "127.0.0.1", () => {
    console.log(`  Viewer: http://localhost:${VIEWER_PORT}`);
  });

  return server;
}

// ─── Self-contained HTML viewer ──────────────────────────────────────────────

const VIEWER_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>⚡ Code Memory — budget-aware-mcp</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>.toast{animation:fadeout 3s forwards}@keyframes fadeout{0%,70%{opacity:1}100%{opacity:0}}.card-enter{animation:slideIn .2s ease}@keyframes slideIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}</style>
</head>
<body class="bg-gray-50 min-h-screen">
<div class="flex h-screen overflow-hidden">

<!-- Sidebar -->
<aside class="w-64 bg-gray-900 text-white flex flex-col">
  <div class="p-4 border-b border-gray-700">
    <h1 class="text-lg font-bold">⚡ Code Memory</h1>
    <p class="text-xs text-gray-400 mt-1">budget-aware-mcp</p>
  </div>
  <nav class="flex-1 overflow-y-auto p-2">
    <div class="text-xs text-gray-500 uppercase tracking-wide px-3 py-2">Memory</div>
    <button onclick="showView('all')" class="nav-btn w-full text-left px-3 py-2 rounded text-sm text-gray-300 hover:bg-gray-700 hover:text-white transition-colors mb-1" data-view="all">All Objects</button>
    <button onclick="showView('decisions')" class="nav-btn w-full text-left px-3 py-2 rounded text-sm text-gray-300 hover:bg-gray-700 hover:text-white transition-colors mb-1" data-view="decisions">Decisions</button>
    <button onclick="showView('workflows')" class="nav-btn w-full text-left px-3 py-2 rounded text-sm text-gray-300 hover:bg-gray-700 hover:text-white transition-colors mb-1" data-view="workflows">Workflows</button>
    <button onclick="showView('gotchas')" class="nav-btn w-full text-left px-3 py-2 rounded text-sm text-gray-300 hover:bg-gray-700 hover:text-white transition-colors mb-1" data-view="gotchas">Gotchas</button>
    <button onclick="showView('conventions')" class="nav-btn w-full text-left px-3 py-2 rounded text-sm text-gray-300 hover:bg-gray-700 hover:text-white transition-colors mb-1" data-view="conventions">Conventions</button>
    <div class="text-xs text-gray-500 uppercase tracking-wide px-3 py-2 mt-4">Code Graph</div>
    <button onclick="showView('graph')" class="nav-btn w-full text-left px-3 py-2 rounded text-sm text-gray-300 hover:bg-gray-700 hover:text-white transition-colors mb-1" data-view="graph">Symbols</button>
    <button onclick="showView('repos')" class="nav-btn w-full text-left px-3 py-2 rounded text-sm text-gray-300 hover:bg-gray-700 hover:text-white transition-colors mb-1" data-view="repos">Repositories</button>
  </nav>
  <div class="p-4 border-t border-gray-700">
    <div class="text-xs text-gray-500" id="sidebar-stats"></div>
  </div>
</aside>

<!-- Main -->
<main class="flex-1 overflow-y-auto">
  <div class="bg-white border-b px-6 py-4 flex items-center justify-between sticky top-0 z-10">
    <div>
      <h2 class="text-xl font-semibold text-gray-800" id="page-title">Project Memory</h2>
      <p class="text-sm text-gray-500" id="page-subtitle">Knowledge that persists across sessions</p>
    </div>
    <div class="flex gap-2">
      <input id="search" type="text" placeholder="Search..." class="border border-gray-300 rounded px-3 py-2 text-sm w-64 focus:outline-none focus:ring-2 focus:ring-blue-500" />
      <button onclick="refresh()" class="bg-gray-100 text-gray-700 px-3 py-2 rounded text-sm hover:bg-gray-200">&#8635;</button>
    </div>
  </div>

  <div class="p-6" id="content"></div>
</main>
</div>

<script>
let memoryData = [];
let graphData = { symbols: [], edges: [] };
let statsData = {};
let currentView = 'all';

async function loadData() {
  const [mem, graph, stats] = await Promise.all([
    fetch('/api/memory').then(r => r.json()).catch(() => ({ objects: [], stats: {} })),
    fetch('/api/graph').then(r => r.json()).catch(() => ({ symbols: [], edges: [] })),
    fetch('/api/stats').then(r => r.json()).catch(() => ({ repos: [], memory: {} })),
  ]);
  memoryData = mem.objects || [];
  graphData = graph;
  statsData = { ...stats, memStats: mem.stats || {} };
  renderSidebarStats();
  render();
}

function renderSidebarStats() {
  const el = document.getElementById('sidebar-stats');
  const ms = statsData.memStats || {};
  el.innerHTML = '<div>' + (ms.total || 0) + ' memories</div><div>' + (graphData.symbols?.length || 0) + ' symbols</div>';
}

function showView(view) {
  currentView = view;
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('bg-gray-700', 'text-white'));
  document.querySelector('[data-view="'+view+'"]')?.classList.add('bg-gray-700', 'text-white');
  render();
}

function render() {
  const query = document.getElementById('search').value.toLowerCase();
  switch(currentView) {
    case 'all': renderMemory(memoryData, query); break;
    case 'decisions': renderMemory(memoryData.filter(o => o.type === 'decision'), query); break;
    case 'workflows': renderMemory(memoryData.filter(o => o.type === 'workflow'), query); break;
    case 'gotchas': renderMemory(memoryData.filter(o => o.type === 'gotcha'), query); break;
    case 'conventions': renderMemory(memoryData.filter(o => o.type === 'convention'), query); break;
    case 'graph': renderGraph(); break;
    case 'repos': renderRepos(); break;
  }
}

function renderMemory(objects, query) {
  const el = document.getElementById('content');
  let filtered = objects;
  if (query) filtered = filtered.filter(o => (o.title + ' ' + o.content + ' ' + (o.tags||[]).join(' ')).toLowerCase().includes(query));

  if (filtered.length === 0) {
    el.innerHTML = '<div class="text-center text-gray-400 mt-20"><div class="text-5xl mb-4">📝</div><p class="text-lg">No memory objects yet</p><p class="text-sm mt-2">Agents will save decisions, workflows, and gotchas here via MCP tools.</p></div>';
    updateHeader('Memory', filtered.length + ' objects');
    return;
  }

  updateHeader(currentView === 'all' ? 'All Memory' : currentView.charAt(0).toUpperCase() + currentView.slice(1), filtered.length + ' objects');

  el.innerHTML = '<div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">' + filtered.map(o => {
    const age = Math.floor((Date.now() - new Date(o.confirmed_at || o.created_at).getTime()) / 86400000);
    const freshness = age < 1 ? '<span class="text-green-600">today</span>' : age < 7 ? age + 'd ago' : age < 30 ? Math.floor(age/7) + 'w ago' : Math.floor(age/30) + 'mo ago';
    const typeColors = { decision:'red', workflow:'blue', gotcha:'amber', convention:'purple', context:'green', source:'gray', synthesis:'indigo' };
    const color = typeColors[o.type] || 'gray';

    return '<div class="card-enter bg-white rounded-lg border border-gray-200 p-4 hover:shadow-md hover:border-blue-300 transition-all">' +
      '<div class="flex items-center gap-2 mb-2">' +
        '<span class="text-xs font-medium px-2 py-0.5 rounded-full bg-'+color+'-100 text-'+color+'-700">' + o.type + '</span>' +
        '<span class="text-xs text-gray-400">' + freshness + '</span>' +
        (o.access_count > 0 ? '<span class="text-xs text-gray-400 ml-auto">' + o.access_count + ' reads</span>' : '') +
      '</div>' +
      '<h3 class="font-semibold text-gray-800 text-sm mb-1">' + esc(o.title) + '</h3>' +
      '<p class="text-sm text-gray-600 line-clamp-3">' + esc(o.content) + '</p>' +
      '<div class="flex flex-wrap gap-1 mt-3">' +
        (o.tags||[]).map(t => '<span class="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded">' + esc(t) + '</span>').join('') +
        (o.symbols?.length ? '<span class="text-xs text-blue-500">⚡' + o.symbols.length + ' symbols</span>' : '') +
        (o.files?.length ? '<span class="text-xs text-gray-400">📁' + o.files.length + ' files</span>' : '') +
      '</div>' +
    '</div>';
  }).join('') + '</div>';
}

function renderGraph() {
  updateHeader('Code Graph', (graphData.symbols?.length || 0) + ' symbols, ' + (graphData.edges?.length || 0) + ' edges');
  const el = document.getElementById('content');
  const syms = (graphData.symbols || []).slice(0, 100);
  const grouped = {};
  syms.forEach(s => { const k = s.kind || 'other'; if (!grouped[k]) grouped[k] = []; grouped[k].push(s); });

  let html = '';
  for (const [kind, items] of Object.entries(grouped)) {
    html += '<div class="mb-6"><h3 class="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-2">' + kind + ' (' + items.length + ')</h3>';
    html += '<div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">';
    html += items.slice(0, 30).map(s =>
      '<div class="bg-white border border-gray-200 rounded px-3 py-2 text-sm hover:border-blue-300 transition-colors">' +
        '<span class="font-mono text-blue-600">' + esc(s.name) + '</span>' +
        '<span class="text-gray-400 text-xs ml-2">' + esc((s.file_path||'').split('/').pop()) + '</span>' +
      '</div>'
    ).join('');
    html += '</div></div>';
  }
  el.innerHTML = html || '<div class="text-center text-gray-400 mt-20">No symbols indexed yet.</div>';
}

function renderRepos() {
  updateHeader('Repositories', (statsData.repos?.length || 0) + ' indexed');
  const el = document.getElementById('content');
  const repos = statsData.repos || [];
  if (repos.length === 0) { el.innerHTML = '<div class="text-center text-gray-400 mt-20">No repositories indexed.</div>'; return; }

  el.innerHTML = '<div class="space-y-4">' + repos.map(r =>
    '<div class="bg-white border border-gray-200 rounded-lg p-5">' +
      '<h3 class="font-semibold text-gray-800">' + esc(r.name) + '</h3>' +
      '<div class="mt-2 grid grid-cols-3 gap-4 text-sm">' +
        '<div><span class="text-gray-500">Files:</span> <span class="font-medium">' + (r.file_count||0) + '</span></div>' +
        '<div><span class="text-gray-500">Symbols:</span> <span class="font-medium">' + (r.symbol_count||0) + '</span></div>' +
        '<div><span class="text-gray-500">LOC:</span> <span class="font-medium">' + ((r.total_loc||0).toLocaleString()) + '</span></div>' +
      '</div>' +
    '</div>'
  ).join('') + '</div>';
}

function updateHeader(title, subtitle) {
  document.getElementById('page-title').textContent = title;
  document.getElementById('page-subtitle').textContent = subtitle;
}

function refresh() { loadData(); }
function esc(s) { return (s||'').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

document.getElementById('search').addEventListener('input', render);
loadData();
setInterval(loadData, 15000);
</script>
</body>
</html>`;
