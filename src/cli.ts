#!/usr/bin/env node
/**
 * budget-aware-mcp CLI
 *
 * Commands:
 *   (default)    Run as MCP server on stdio
 *   install      Auto-detect AI agents and configure MCP
 *   uninstall    Remove MCP config from all agents
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const HOME = os.homedir();
const IS_WIN = process.platform === "win32";

// Resolve the path to the MCP server entry point
const SERVER_PATH = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")),
  "index.js"
);

interface AgentConfig {
  name: string;
  detect: () => boolean;
  configPath: () => string;
  write: (serverPath: string) => void;
}

// ─── Agent definitions ────────────────────────────────────────────

const agents: AgentConfig[] = [
  {
    name: "Kiro",
    detect: () => {
      // Check for .kiro in common workspace locations or user-level
      const userLevel = path.join(HOME, ".kiro", "settings", "mcp.json");
      return fs.existsSync(path.join(HOME, ".kiro")) || fs.existsSync(userLevel);
    },
    configPath: () => path.join(HOME, ".kiro", "settings", "mcp.json"),
    write: (serverPath) => writeMcpJson(
      path.join(HOME, ".kiro", "settings", "mcp.json"),
      "budget-aware-mcp",
      serverPath
    ),
  },
  {
    name: "Claude Code",
    detect: () => fs.existsSync(path.join(HOME, ".claude")),
    configPath: () => path.join(HOME, ".claude", "mcp.json"),
    write: (serverPath) => writeMcpJson(
      path.join(HOME, ".claude", "mcp.json"),
      "budget-aware-mcp",
      serverPath
    ),
  },
  {
    name: "Cursor",
    detect: () => {
      if (IS_WIN) return fs.existsSync(path.join(process.env.APPDATA || "", "Cursor"));
      if (process.platform === "darwin") return fs.existsSync(path.join(HOME, "Library", "Application Support", "Cursor"));
      return fs.existsSync(path.join(HOME, ".config", "cursor"));
    },
    configPath: () => {
      if (IS_WIN) return path.join(process.env.APPDATA || "", "Cursor", "User", "mcp.json");
      if (process.platform === "darwin") return path.join(HOME, "Library", "Application Support", "Cursor", "User", "mcp.json");
      return path.join(HOME, ".config", "cursor", "User", "mcp.json");
    },
    write: (serverPath) => {
      const configPath = agents.find(a => a.name === "Cursor")!.configPath();
      writeMcpJson(configPath, "budget-aware-mcp", serverPath);
    },
  },
  {
    name: "VS Code (Copilot)",
    detect: () => {
      if (IS_WIN) return fs.existsSync(path.join(process.env.APPDATA || "", "Code"));
      if (process.platform === "darwin") return fs.existsSync(path.join(HOME, "Library", "Application Support", "Code"));
      return fs.existsSync(path.join(HOME, ".config", "Code"));
    },
    configPath: () => {
      if (IS_WIN) return path.join(process.env.APPDATA || "", "Code", "User", "mcp.json");
      if (process.platform === "darwin") return path.join(HOME, "Library", "Application Support", "Code", "User", "mcp.json");
      return path.join(HOME, ".config", "Code", "User", "mcp.json");
    },
    write: (serverPath) => {
      const configPath = agents.find(a => a.name === "VS Code (Copilot)")!.configPath();
      writeVsCodeMcp(configPath, "budget-aware-mcp", serverPath);
    },
  },
  {
    name: "Windsurf",
    detect: () => {
      if (IS_WIN) return fs.existsSync(path.join(process.env.APPDATA || "", "Windsurf"));
      if (process.platform === "darwin") return fs.existsSync(path.join(HOME, "Library", "Application Support", "Windsurf"));
      return fs.existsSync(path.join(HOME, ".config", "windsurf"));
    },
    configPath: () => {
      if (IS_WIN) return path.join(process.env.APPDATA || "", "Windsurf", "User", "mcp.json");
      if (process.platform === "darwin") return path.join(HOME, "Library", "Application Support", "Windsurf", "User", "mcp.json");
      return path.join(HOME, ".config", "windsurf", "User", "mcp.json");
    },
    write: (serverPath) => {
      const configPath = agents.find(a => a.name === "Windsurf")!.configPath();
      writeMcpJson(configPath, "budget-aware-mcp", serverPath);
    },
  },
  {
    name: "Zed",
    detect: () => {
      if (process.platform === "darwin") return fs.existsSync(path.join(HOME, ".config", "zed"));
      return fs.existsSync(path.join(HOME, ".config", "zed"));
    },
    configPath: () => path.join(HOME, ".config", "zed", "settings.json"),
    write: (serverPath) => writeZedConfig(serverPath),
  },
  {
    name: "Codex CLI",
    detect: () => fs.existsSync(path.join(HOME, ".codex")),
    configPath: () => path.join(HOME, ".codex", "config.toml"),
    write: (serverPath) => writeCodexConfig(serverPath),
  },
  {
    name: "Gemini CLI",
    detect: () => fs.existsSync(path.join(HOME, ".gemini")),
    configPath: () => path.join(HOME, ".gemini", "settings.json"),
    write: (serverPath) => writeMcpJson(
      path.join(HOME, ".gemini", "settings.json"),
      "budget-aware-mcp",
      serverPath,
      "mcpServers"
    ),
  },
  {
    name: "Aider",
    detect: () => fs.existsSync(path.join(HOME, ".aider.conf.yml")) || fs.existsSync(path.join(HOME, ".config", "aider")),
    configPath: () => path.join(HOME, ".config", "aider", "mcp.json"),
    write: (serverPath) => writeMcpJson(
      path.join(HOME, ".config", "aider", "mcp.json"),
      "budget-aware-mcp",
      serverPath
    ),
  },
  {
    name: "OpenCode",
    detect: () => fs.existsSync(path.join(HOME, ".config", "opencode")),
    configPath: () => path.join(HOME, ".config", "opencode", "mcp.json"),
    write: (serverPath) => writeMcpJson(
      path.join(HOME, ".config", "opencode", "mcp.json"),
      "budget-aware-mcp",
      serverPath
    ),
  },
];

// ─── Config writers ───────────────────────────────────────────────

function ensureDir(filePath: string) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * Standard MCP config format: { "mcpServers": { "name": { "command": "node", "args": [...] } } }
 */
function writeMcpJson(configPath: string, serverName: string, serverPath: string, key = "mcpServers") {
  ensureDir(configPath);
  let config: any = {};
  if (fs.existsSync(configPath)) {
    try { config = JSON.parse(fs.readFileSync(configPath, "utf-8")); } catch { config = {}; }
  }

  if (!config[key]) config[key] = {};
  config[key][serverName] = {
    command: "node",
    args: [serverPath],
    disabled: false,
  };

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
}

/**
 * VS Code uses { "servers": { "name": { "type": "stdio", "command": "node", "args": [...] } } }
 */
function writeVsCodeMcp(configPath: string, serverName: string, serverPath: string) {
  ensureDir(configPath);
  let config: any = {};
  if (fs.existsSync(configPath)) {
    try { config = JSON.parse(fs.readFileSync(configPath, "utf-8")); } catch { config = {}; }
  }

  if (!config.servers) config.servers = {};
  config.servers[serverName] = {
    type: "stdio",
    command: "node",
    args: [serverPath],
  };

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
}

/**
 * Zed uses settings.json with context_servers key.
 */
function writeZedConfig(serverPath: string) {
  const configPath = path.join(HOME, ".config", "zed", "settings.json");
  ensureDir(configPath);
  let config: any = {};
  if (fs.existsSync(configPath)) {
    try { config = JSON.parse(fs.readFileSync(configPath, "utf-8")); } catch { config = {}; }
  }

  if (!config.context_servers) config.context_servers = {};
  config.context_servers["budget-aware-mcp"] = {
    command: { path: "node", args: [serverPath] },
    settings: {},
  };

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
}

/**
 * Codex CLI uses TOML config.
 */
function writeCodexConfig(serverPath: string) {
  const configPath = path.join(HOME, ".codex", "config.toml");
  ensureDir(configPath);
  let content = "";
  if (fs.existsSync(configPath)) {
    content = fs.readFileSync(configPath, "utf-8");
  }

  if (!content.includes("budget-aware-mcp")) {
    content += `\n[mcp_servers.budget-aware-mcp]\ncommand = "node"\nargs = ["${serverPath.replace(/\\/g, "/")}"]\n`;
    fs.writeFileSync(configPath, content);
  }
}

// ─── Commands ─────────────────────────────────────────────────────

function cmdInstall() {
  console.log("budget-aware-mcp — auto-configure\n");
  console.log("Detecting installed AI agents...\n");

  const detected = agents.filter(a => a.detect());

  if (detected.length === 0) {
    console.log("  No supported AI agents detected.");
    console.log("  Supported: Kiro, Claude Code, Cursor, VS Code, Windsurf, Zed, Codex, Gemini CLI, Aider, OpenCode");
    console.log("\n  Manual setup: add to your MCP config:");
    console.log(`    { "mcpServers": { "budget-aware-mcp": { "command": "node", "args": ["${SERVER_PATH}"] } } }`);
    process.exit(0);
  }

  console.log(`  Found ${detected.length} agent(s):\n`);

  for (const agent of detected) {
    try {
      agent.write(SERVER_PATH);
      console.log(`  ✓ ${agent.name} — configured (${agent.configPath()})`);
    } catch (e: any) {
      console.log(`  ✗ ${agent.name} — failed: ${e.message}`);
    }
  }

  console.log("\n  Done! Restart your agent(s) to activate budget-aware-mcp.");
  console.log("  15 tools available: graph_walk, search_graph, fuzzy_find_symbol, check_scope, ...");
}

function cmdUninstall() {
  console.log("budget-aware-mcp — removing configuration\n");

  for (const agent of agents) {
    const configPath = agent.configPath();
    if (!fs.existsSync(configPath)) continue;

    try {
      const content = fs.readFileSync(configPath, "utf-8");
      const config = JSON.parse(content);

      let removed = false;
      if (config.mcpServers?.["budget-aware-mcp"]) { delete config.mcpServers["budget-aware-mcp"]; removed = true; }
      if (config.servers?.["budget-aware-mcp"]) { delete config.servers["budget-aware-mcp"]; removed = true; }
      if (config.context_servers?.["budget-aware-mcp"]) { delete config.context_servers["budget-aware-mcp"]; removed = true; }

      if (removed) {
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
        console.log(`  ✓ ${agent.name} — removed`);
      }
    } catch { /* skip */ }
  }

  console.log("\n  Done.");
}

// ─── Main ─────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args[0] === "install") {
  cmdInstall();
} else if (args[0] === "uninstall") {
  cmdUninstall();
} else if (args[0] === "view" || args[0] === "ui") {
  // Launch the 3D spatial code graph + memory API
  console.log("⚡ Code Graph Viewer");
  console.log("");

  // Start the memory API server (serves data to the 3D UI)
  import("./memory/viewer.js").then(async ({ startViewer }) => {
    const { MemoryStore } = await import("./memory/store.js");
    const { db: graphDb } = await import("./db.js");
    graphDb.initialize();
    const store = new MemoryStore();
    startViewer(store);
  });

  // Launch the 3D graph-ui (Vite dev server)
  const selfDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1"));
  const graphUiCandidates = [
    path.resolve(selfDir, "..", "codebase-memory-mcp-main", "graph-ui"),
    path.resolve(selfDir, "..", "..", "codebase-memory-mcp-main", "graph-ui"),
    path.resolve(process.cwd(), "code-graph-mcp", "codebase-memory-mcp-main", "graph-ui"),
    path.resolve(process.cwd(), "codebase-memory-mcp-main", "graph-ui"),
  ];
  const graphUiDir = graphUiCandidates.find(p => fs.existsSync(path.join(p, "package.json")));

  if (graphUiDir) {
    import("child_process").then(({ exec }) => {
      const child = exec("npx vite --port 5173 --open", { cwd: graphUiDir });
      child.stdout?.on("data", (d: string) => {
        if (d.includes("Local:")) console.log(`  3D Graph: ${d.trim().split("Local:")[1]?.trim() || "http://localhost:5173"}`);
      });
      child.stderr?.on("data", () => {});
      child.on("error", () => {
        console.log("  3D Graph: could not start (run 'npm install' in graph-ui first)");
      });
      console.log("  Memory API: http://localhost:4321");
      console.log("  Starting 3D graph...\n");
    });
  } else {
    console.log("  3D graph-ui not found. Memory viewer at http://localhost:4321");
    console.log("  Press Ctrl+C to stop.\n");
    // Open the flat memory viewer instead
    import("child_process").then(({ exec }) => {
      if (process.platform === "win32") exec("start http://localhost:4321");
      else if (process.platform === "darwin") exec("open http://localhost:4321");
      else exec("xdg-open http://localhost:4321");
    });
  }
} else if (args[0] === "memory") {
  // CLI memory commands
  import("./memory/store.js").then(({ MemoryStore }) => {
    const store = new MemoryStore();
    const sub = args[1];

    if (!sub || sub === "list") {
      const objects = store.all();
      if (objects.length === 0) {
        console.log("No memory stored yet.");
        console.log("Use the memory_remember MCP tool to save decisions, workflows, and gotchas.");
      } else {
        console.log(`Project memory (${objects.length} objects):\n`);
        for (const obj of objects) {
          const age = Math.floor((Date.now() - new Date(obj.confirmed_at).getTime()) / 86400000);
          console.log(`  [${obj.type}] ${obj.title} (${age}d old, ${obj.access_count} reads)`);
        }
      }
    } else if (sub === "stats") {
      const stats = store.stats();
      console.log(`Memory: ${stats.total} objects`);
      for (const [type, count] of Object.entries(stats.byType)) {
        console.log(`  ${type}: ${count}`);
      }
    } else if (sub === "prune") {
      const days = parseInt(args[2] || "90");
      const pruned = store.pruneStale(days);
      console.log(`Pruned ${pruned} stale memories (not confirmed in ${days}+ days).`);
    } else {
      console.log("Usage:");
      console.log("  budget-aware-mcp memory         List all memory");
      console.log("  budget-aware-mcp memory stats   Show statistics");
      console.log("  budget-aware-mcp memory prune   Remove stale entries");
    }
  });
} else if (args[0] === "--help" || args[0] === "-h") {
  console.log("budget-aware-mcp — Budget-aware code memory for AI agents\n");
  console.log("Usage:");
  console.log("  budget-aware-mcp             Run MCP server on stdio");
  console.log("  budget-aware-mcp install     Auto-detect agents and configure MCP");
  console.log("  budget-aware-mcp uninstall   Remove MCP config from all agents");
  console.log("  budget-aware-mcp view        Open memory + graph viewer in browser");
  console.log("  budget-aware-mcp memory      List/manage project memory (CLI)");
  console.log("  budget-aware-mcp --help      Show this help");
  console.log("\nSupported agents:");
  console.log("  Kiro, Claude Code, Cursor, VS Code, Windsurf, Zed, Codex CLI, Gemini CLI, Aider, OpenCode");
} else if (args[0] === "--version" || args[0] === "-v") {
  const pkg = JSON.parse(fs.readFileSync(path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")), "..", "package.json"), "utf-8"));
  console.log(`budget-aware-mcp ${pkg.version}`);
} else {
  // Default: run MCP server
  import("./index.js");
}
