'use strict';

// Voice transcription via Groq Whisper. Config: cfg.stt.provider='groq', cfg.stt.apiKey, cfg.stt.model (default 'whisper-large-v3-turbo').
// Input: Buffer of audio bytes + media type (e.g. 'audio/ogg').
// Output: transcript string.
//
// THIRD-PARTY DATA FLOW: When STT is enabled, raw audio bytes received on
// Telegram are uploaded to `api.groq.com` (https) for transcription. This is
// the only place in claudefish where user content leaves the local machine
// besides Anthropic API calls. Disable STT (omit `cfg.stt`) to keep voice
// messages local — they'll still be received but returned to the user as
// "transcription not configured".

const https = require('https');
const { randomBytes } = require('crypto');

function buildMultipart(fields, fileField, fileName, fileBytes, fileType) {
  const boundary = '----cf' + randomBytes(12).toString('hex');
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${fileName}"\r\nContent-Type: ${fileType}\r\n\r\n`));
  parts.push(fileBytes);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function transcribeGroq({ apiKey, audio, mediaType = 'audio/ogg', model = 'whisper-large-v3-turbo', fileName = 'voice.ogg' }) {
  if (!apiKey) throw new Error('missing groq apiKey');
  const { body, contentType } = buildMultipart(
    { model, response_format: 'json', temperature: '0' },
    'file', fileName, audio, mediaType
  );
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, v) => { if (!settled) { settled = true; clearTimeout(guard); fn(v); } };
    const req = https.request({
      hostname: 'api.groq.com', port: 443,
      path: '/openai/v1/audio/transcriptions', method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': contentType, 'content-length': body.length }
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 400) return finish(reject, new Error(`groq ${res.statusCode}: ${raw.slice(0, 300)}`));
        try { const j = JSON.parse(raw); finish(resolve, j.text || ''); }
        catch (e) { finish(reject, new Error(`groq bad json: ${e.message}`)); }
      });
      res.on('error', e => finish(reject, e));
    });
    req.on('error', e => finish(reject, e));
    const guard = setTimeout(() => { try { req.destroy(new Error('stt timeout')); } catch {} finish(reject, new Error('stt timeout 60s')); }, 60_000);
    req.write(body);
    req.end();
  });
}

async function transcribe(cfg, audio, mediaType, fileName) {
  const stt = cfg.stt || {};
  if (stt.provider && stt.provider !== 'groq') throw new Error(`unsupported stt provider: ${stt.provider}`);
  return transcribeGroq({ apiKey: stt.apiKey, audio, mediaType, model: stt.model, fileName });
}

module.exports = { transcribe };
