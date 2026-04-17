'use strict';

// SSRF guard. Rejects URLs that point to private/loopback/link-local ranges or
// to hostnames that resolve there. Used by webhook add + every outbound POST.

const dns = require('dns').promises;
const net = require('net');

function _ipv4InRange(ip, cidr) {
  const [range, bitsStr] = cidr.split('/');
  const bits = parseInt(bitsStr, 10);
  const toInt = a => a.split('.').reduce((n, o) => (n << 8) + parseInt(o, 10), 0) >>> 0;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (toInt(ip) & mask) === (toInt(range) & mask);
}

const BLOCKED_V4 = [
  '127.0.0.0/8',    // loopback
  '10.0.0.0/8',     // RFC1918
  '172.16.0.0/12',  // RFC1918
  '192.168.0.0/16', // RFC1918
  '169.254.0.0/16', // link-local
  '0.0.0.0/8',      // "this network"
  '100.64.0.0/10'   // CGNAT
];

function _isBlockedIp(ip) {
  if (net.isIPv4(ip)) {
    return BLOCKED_V4.some(c => _ipv4InRange(ip, c));
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    // IPv4-mapped (::ffff:x.x.x.x)
    const m = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return _isBlockedIp(m[1]);
    // link-local fe80::/10
    if (/^fe[89ab]/.test(lower)) return true;
    // unique local fc00::/7
    if (/^f[cd]/.test(lower)) return true;
    return false;
  }
  return true; // unknown family → reject
}

function _isBlockedHostname(h) {
  const host = String(h || '').toLowerCase().trim();
  if (!host) return true;
  if (host === 'localhost') return true;
  if (host.endsWith('.local') || host.endsWith('.internal')
      || host.endsWith('.localhost') || host.endsWith('.lan')) return true;
  return false;
}

// Check a URL for SSRF risk. Returns true if safe to fetch.
async function isPublicUrl(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname;
  if (_isBlockedHostname(host)) return false;
  // If hostname is already a literal IP, check directly.
  if (net.isIP(host)) return !_isBlockedIp(host);
  // Otherwise resolve and reject if ANY returned address is blocked.
  try {
    const addrs = await dns.lookup(host, { all: true });
    if (!addrs || !addrs.length) return false;
    for (const a of addrs) {
      if (_isBlockedIp(a.address)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

module.exports = { isPublicUrl };
