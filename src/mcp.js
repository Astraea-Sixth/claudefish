'use strict';

// Minimal MCP client over stdio. Reads config from data/mcp.json:
// { "servers": { "name": { "command": "cmd", "args": [...], "env": {...} } } }
// Exposes tool definitions with name prefixed by server.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

class MCPClient {
  constructor(name, { command, args = [], env = {} }) {
    this.name = name;
    this.proc = spawn(command, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.buf = '';
    this.nextId = 1;
    this.pending = new Map();
    this.tools = [];
    this.proc.stdout.on('data', d => this._onData(d));
    this.proc.stderr.on('data', d => process.stderr.write(`[mcp:${name}] ${d}`));
    this.proc.on('exit', code => console.log(`[mcp:${name}] exit ${code}`));
  }

  _onData(d) {
    this.buf += d.toString();
    let idx;
    while ((idx = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, idx); this.buf = this.buf.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          msg.error ? reject(new Error(msg.error.message || 'mcp error')) : resolve(msg.result);
        }
      } catch {}
    }
  }

  _rpc(method, params) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('mcp timeout')); } }, 30_000);
    });
  }

  async init() {
    await this._rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'claudefish', version: '0.1' } });
    try { this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'); } catch {}
    const { tools = [] } = await this._rpc('tools/list', {});
    this.tools = tools;
    return tools;
  }

  async call(toolName, args) {
    const result = await this._rpc('tools/call', { name: toolName, arguments: args });
    if (result?.content) return result.content.map(c => c.text || JSON.stringify(c)).join('\n');
    return JSON.stringify(result);
  }

  stop() { try { this.proc.kill(); } catch {} }
}

async function loadMCP(configPath) {
  if (!fs.existsSync(configPath)) return { defs: [], handlers: {}, clients: [] };
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')); }
  catch (e) { console.error(`[mcp] config parse: ${e.message}`); return { defs: [], handlers: {}, clients: [] }; }
  const defs = [], handlers = {}, clients = [];
  for (const [name, spec] of Object.entries(cfg.servers || {})) {
    try {
      const c = new MCPClient(name, spec);
      const tools = await c.init();
      clients.push(c);
      for (const t of tools) {
        const full = `mcp_${name}_${t.name}`;
        defs.push({ name: full, description: t.description || `${name}:${t.name}`, input_schema: t.inputSchema || { type: 'object' } });
        handlers[full] = args => c.call(t.name, args || {});
      }
      console.log(`[mcp] ${name}: ${tools.length} tools`);
    } catch (e) {
      console.error(`[mcp] ${name}: ${e.message}`);
    }
  }
  return { defs, handlers, clients };
}

module.exports = { loadMCP, MCPClient };
