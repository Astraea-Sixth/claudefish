'use strict';

// Helpers to scrub user-facing error messages of local filesystem paths.
// Replaces $HOME with ~ and strips the repo root prefix so we don't leak
// e.g. /Users/alice/... to Telegram.

const os = require('os');
const path = require('path');

const HOME = os.homedir();
// Repo root is one level above this file (src/errors.js → repo root).
const REPO_ROOT = path.resolve(__dirname, '..');

function scrubString(s) {
  if (typeof s !== 'string') return s;
  let out = s;
  // Longest-prefix-first: repo root should match before generic $HOME.
  if (REPO_ROOT && REPO_ROOT !== '/' && out.includes(REPO_ROOT)) {
    out = out.split(REPO_ROOT).join('');
  }
  if (HOME && HOME !== '/' && out.includes(HOME)) {
    out = out.split(HOME).join('~');
  }
  return out;
}

// Scrub an Error (or error-ish object) — returns the .message with paths scrubbed.
function scrubMessage(e) {
  if (!e) return '';
  const raw = typeof e === 'string' ? e : (e.message || String(e));
  return scrubString(raw);
}

module.exports = { scrubMessage, scrubString };
