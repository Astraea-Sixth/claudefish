'use strict';

const https = require('https');
const { getAccessToken, betasHeader } = require('./billing');

const API_HOST = 'api.anthropic.com';
const DEBUG = process.env.CLAUDEFISH_DEBUG === '1';
function dbg(...args) { if (DEBUG) console.log(...args); }

function postJSON(pathname, headers, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body), 'utf8');
    const req = https.request({
      hostname: API_HOST, port: 443, path: pathname, method: 'POST',
      headers: { ...headers, 'content-length': data.length }
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 400) return reject(new Error(`API ${res.statusCode}: ${raw.slice(0, 500)}`));
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error(`bad JSON: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(120_000, () => { req.destroy(new Error('API request timeout after 120s')); });
    req.write(data);
    req.end();
  });
}

function baseHeaders(token) {
  return {
    'content-type': 'application/json',
    'authorization': `Bearer ${token}`,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': betasHeader(),
    'user-agent': 'claude-cli/2.1.97',
    'x-app': 'cli',
    'accept': 'application/json',
    'accept-encoding': 'identity'
  };
}

async function createMessage(credsLoc, { model, system, messages, tools, maxTokens, thinking }) {
  const token = await getAccessToken(credsLoc);
  const body = { model, max_tokens: maxTokens || 8192, system, messages };
  if (tools && tools.length) body.tools = tools;
  if (thinking) body.thinking = thinking;
  return postJSON('/v1/messages', baseHeaders(token), body);
}

// Streaming version. onDelta({ textSoFar, newText }) fires as text tokens arrive.
// Returns the final message shape: { content: [...], stop_reason, usage }.
async function streamMessage(credsLoc, { model, system, messages, tools, maxTokens, thinking }, onDelta) {
  const t0 = Date.now();
  dbg(`[claude] streamMessage: acquiring token`);
  const token = await getAccessToken(credsLoc);
  dbg(`[claude] streamMessage: token ok (${Date.now() - t0}ms), sending request`);
  const body = { model, max_tokens: maxTokens || 8192, system, messages, stream: true };
  if (tools && tools.length) body.tools = tools;
  if (thinking) body.thinking = thinking;

  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, val) => { if (!settled) { settled = true; clearTimeout(wallTimer); fn(val); } };
    const wallTimer = setTimeout(() => {
      try { req.destroy(new Error('streamMessage wall-clock timeout 180s')); } catch {}
      settle(reject, new Error('streamMessage wall-clock timeout 180s'));
    }, 180_000);
    const data = Buffer.from(JSON.stringify(body), 'utf8');
    const headers = { ...baseHeaders(token), 'content-length': data.length, accept: 'text/event-stream' };
    const req = https.request({ hostname: API_HOST, port: 443, path: '/v1/messages', method: 'POST', headers }, res => {
      if (res.statusCode >= 400) {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => reject(new Error(`API ${res.statusCode}: ${Buffer.concat(chunks).toString('utf8').slice(0, 500)}`)));
        return;
      }
      let buf = '';
      const contentBlocks = []; // { type, text?, id?, name?, input?, _inputJson? }
      let finalMsg = { content: [], stop_reason: null, usage: {} };
      let textSoFar = '';

      res.on('data', chunk => {
        buf += chunk.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const evt = buf.slice(0, idx); buf = buf.slice(idx + 2);
          const dataLine = evt.split('\n').find(l => l.startsWith('data: '));
          if (!dataLine) continue;
          const payload = dataLine.slice(6);
          if (payload === '[DONE]') continue;
          let j;
          try { j = JSON.parse(payload); } catch { continue; }
          if (j.type === 'message_start' && j.message) {
            finalMsg.usage = j.message.usage || {};
          } else if (j.type === 'content_block_start') {
            contentBlocks[j.index] = { ...j.content_block, _inputJson: '' };
          } else if (j.type === 'content_block_delta') {
            const b = contentBlocks[j.index];
            if (!b) continue;
            if (j.delta.type === 'text_delta') {
              b.text = (b.text || '') + j.delta.text;
              textSoFar += j.delta.text;
              if (onDelta) { try { onDelta({ textSoFar, newText: j.delta.text }); } catch {} }
            } else if (j.delta.type === 'input_json_delta') {
              b._inputJson += j.delta.partial_json || '';
            } else if (j.delta.type === 'thinking_delta') {
              b.thinking = (b.thinking || '') + (j.delta.thinking || '');
            }
          } else if (j.type === 'content_block_stop') {
            const b = contentBlocks[j.index];
            if (b && b.type === 'tool_use' && b._inputJson) {
              try { b.input = JSON.parse(b._inputJson); } catch { b.input = {}; }
            }
            if (b) delete b._inputJson;
          } else if (j.type === 'message_delta') {
            if (j.delta?.stop_reason) finalMsg.stop_reason = j.delta.stop_reason;
            if (j.usage) finalMsg.usage = { ...finalMsg.usage, ...j.usage };
          }
        }
      });
      res.on('end', () => {
        dbg(`[claude] streamMessage: done (${Date.now() - t0}ms, ${contentBlocks.length} blocks)`);
        // Belt-and-suspenders: clean internal fields before returning. If the
        // stream closed before all content_block_stop events, _inputJson leaks
        // into history and Anthropic rejects it as "Extra inputs are not permitted"
        // on the next turn.
        for (const b of contentBlocks) {
          if (!b) continue;
          if (b.type === 'tool_use' && b._inputJson) {
            try { b.input = JSON.parse(b._inputJson); } catch { b.input = {}; }
          }
          delete b._inputJson;
        }
        finalMsg.content = contentBlocks.filter(Boolean);
        settle(resolve, finalMsg);
      });
      res.on('error', e => settle(reject, e));
    });
    req.on('error', e => settle(reject, e));
    req.setTimeout(120_000, () => { req.destroy(new Error('API socket idle 120s')); });
    req.write(data);
    req.end();
  });
}

module.exports = { createMessage, streamMessage };
