'use strict';

// Trust-on-first-use per (tool, scope) pair.
// Scope examples:
//   claude_code:<projectSlug>
//   bash_exec:cwd=./workspace/projects/foo
//   doc_write:path=projects/foo/
//   url_fetch:domain=github.com
// Use `forget(key)` to revoke.

const fs = require('fs');
const path = require('path');

class ApprovalStore {
  constructor(file) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, '{}', 'utf8');
  }
  _load() { try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return {}; } }
  _save(d) {
    const tmp = `${this.file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(d, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  key(tool, scope) { return scope ? `${tool}:${scope}` : tool; }

  isTrusted(tool, scope) {
    const d = this._load();
    if (d[this.key(tool, scope)]) return true;
    // NOTE: path trust is exact-match (no prefix). Approving one file does not
    // implicitly approve siblings in the same directory. See scopeFor().
    // Domain trust: saved `url_fetch:domain=example.com` also trusts subdomains.
    if (scope && scope.startsWith('domain=')) {
      const target = scope.slice(7);
      for (const k of Object.keys(d)) {
        if (k.startsWith(`${tool}:domain=`)) {
          const dom = k.slice(tool.length + 8);
          if (target === dom || target.endsWith(`.${dom}`)) return true;
        }
      }
    }
    return false;
  }

  trust(tool, scope) {
    const d = this._load();
    d[this.key(tool, scope)] = { ts: Date.now() };
    this._save(d);
  }

  forget(key) {
    const d = this._load();
    delete d[key];
    this._save(d);
  }

  list() { return Object.keys(this._load()); }
}

// Derive the approval scope string from a tool name + its input args.
// Returning null forces a fresh prompt (no auto-trust possible).
function scopeFor(toolName, details = {}) {
  switch (toolName) {
    case 'claude_code':
      return details.project ? `project=${details.project}` : null;
    case 'bash_exec':
      // Never persist cross-invocation trust for bash. Approving `git` once
      // must NOT trust every future `git` invocation (the argv could be
      // anything, including `git clone` or destructive flags). Returning null
      // forces a fresh approval per call.
      return null;
    case 'doc_write': {
      const p = String(details.path || '');
      if (!p) return null;
      // Exact-path scope — approving one file does NOT trust siblings.
      // Normalize: strip repeated slashes and leading ./ so trivially
      // different spellings match.
      const norm = p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\.\//, '');
      return `path=${norm}`;
    }
    case 'url_fetch': {
      try { return `domain=${new URL(details.url).hostname}`; } catch { return null; }
    }
    default:
      return null;
  }
}

module.exports = { ApprovalStore, scopeFor };
