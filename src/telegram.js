'use strict';

const https = require('https');
const { scrubMessage } = require('./errors');

function tgDownloadFile(token, filePath) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.telegram.org', port: 443,
      path: `/file/bot${token}/${filePath}`, method: 'GET'
    }, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`download ${res.statusCode}`)); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.setTimeout(60_000, () => { req.destroy(new Error('timeout')); });
    req.end();
  });
}

function tgRequest(token, method, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body || {}), 'utf8');
    const req = https.request({
      hostname: 'api.telegram.org', port: 443,
      path: `/bot${token}/${method}`, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': data.length }
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try {
          const j = JSON.parse(raw);
          if (!j.ok) return reject(new Error(`TG ${method}: ${j.description}`));
          resolve(j.result);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(35_000, () => { req.destroy(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

const CHUNK = 4000;

class TelegramBot {
  constructor({ token, allowFrom, onMessage, onCallback, transcribe = null, onPriorityCommand = null }) {
    this.token = token;
    // Refuse to run without an explicit allowlist — an empty list previously
    // "failed open" and accepted messages from anyone.
    if (!Array.isArray(allowFrom) || allowFrom.length === 0) {
      throw new Error('Refusing to start: `telegram.allowFrom` must list at least one user ID. Set it in config.json.');
    }
    this.allow = new Set(allowFrom.map(String));
    this.onMessage = onMessage;
    this.onCallback = onCallback;
    this.transcribe = transcribe;
    // Called IMMEDIATELY when a priority command (/stop, /btw) arrives, even
    // while onMessage is blocked on a long tool chain. Runs in the poll loop
    // before the message enters the normal queue.
    this.onPriorityCommand = onPriorityCommand;
    this.offset = 0;
    this.running = false;
    this.pendingApprovals = new Map();
    this.backoff = 0;
    this._handlerBusy = false;
  }

  async send(chatId, text, opts = {}) {
    const s = String(text ?? '');
    if (!s) return null;
    let lastMsg = null;
    for (let i = 0; i < s.length; i += CHUNK) {
      lastMsg = await tgRequest(this.token, 'sendMessage', { chat_id: chatId, text: s.slice(i, i + CHUNK), ...opts });
    }
    return lastMsg;
  }

  async typing(chatId) {
    try { await tgRequest(this.token, 'sendChatAction', { chat_id: chatId, action: 'typing' }); } catch {}
  }

  async editText(chatId, messageId, text) {
    return tgRequest(this.token, 'editMessageText', { chat_id: chatId, message_id: messageId, text: text.slice(0, CHUNK) });
  }

  async answerCallback(id, text) {
    try { await tgRequest(this.token, 'answerCallbackQuery', { callback_query_id: id, text: text || '' }); } catch {}
  }

  async requestApproval(chatId, toolName, details) {
    const id = `ap-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const body = `Approve \`${toolName}\`?\n\n${JSON.stringify(details).slice(0, 2000)}`;
    const kb = { inline_keyboard: [[
      { text: '✅ yes', callback_data: `ap:${id}:y` },
      { text: '❌ no', callback_data: `ap:${id}:n` }
    ]]};
    const sent = await tgRequest(this.token, 'sendMessage', { chat_id: chatId, text: body, reply_markup: kb });
    return new Promise(resolve => {
      this.pendingApprovals.set(id, resolve);
      setTimeout(() => {
        if (this.pendingApprovals.has(id)) {
          this.pendingApprovals.delete(id);
          if (sent?.message_id) this.editText(chatId, sent.message_id, `⏱ timed out — \`${toolName}\` auto-denied`).catch(() => {});
          resolve(false);
        }
      }, 120_000);
    });
  }

  _handleApprovalCallback(data) {
    const m = data.match(/^ap:([^:]+):([yn])$/);
    if (!m) return false;
    const resolver = this.pendingApprovals.get(m[1]);
    if (resolver) {
      this.pendingApprovals.delete(m[1]);
      resolver(m[2] === 'y');
      return true;
    }
    return false;
  }

  async setCommands(commands) {
    try { await tgRequest(this.token, 'setMyCommands', { commands }); }
    catch (e) { console.error(`[tg] setMyCommands: ${e.message}`); }
  }

  async start() {
    this.running = true;
    const me = await tgRequest(this.token, 'getMe', {});
    this.username = me.username || null;
    console.log(`[tg] connected as @${me.username}`);
    while (this.running) {
      try {
        const updates = await tgRequest(this.token, 'getUpdates', { offset: this.offset, timeout: 30, allowed_updates: ['message', 'callback_query'] });
        this.backoff = 0;
        for (const u of updates) {
          this.offset = u.update_id + 1;
          if (u.callback_query) {
            const cq = u.callback_query;
            const data = cq.data || '';
            const handled = this._handleApprovalCallback(data);
            if (handled) {
              await this.answerCallback(cq.id, 'ok');
            } else if (/^ap:/.test(data)) {
              // An approval click whose in-memory resolver is gone — bot probably restarted
              // between the prompt and the tap. Tell the user so they don't sit waiting.
              await this.answerCallback(cq.id, 'expired — ask again');
              try { if (cq.message?.message_id && cq.message?.chat?.id) {
                await this.editText(cq.message.chat.id, cq.message.message_id, '⌛ approval expired (bot restarted). ask me again and re-approve.');
              } } catch {}
            } else {
              await this.answerCallback(cq.id, '');
              if (this.onCallback) {
                try { await this.onCallback({ data, fromId: String(cq.from?.id), chatId: cq.message?.chat?.id, bot: this }); } catch (e) { console.error(`[tg] cb: ${e.message}`); }
              }
            }
            continue;
          }
          const msg = u.message;
          if (!msg) continue;
          const fromId = String(msg.from?.id || '');
          if (!this.allow.has(fromId)) {
            console.log(`[tg] rejected from ${fromId}`);
            continue;
          }
          // Collect any images: largest photo size, plus image-mime documents.
          const imageSpecs = [];
          if (Array.isArray(msg.photo) && msg.photo.length) {
            const biggest = msg.photo.reduce((a, b) => (a.file_size || 0) >= (b.file_size || 0) ? a : b);
            imageSpecs.push({ fileId: biggest.file_id, mediaType: 'image/jpeg' });
          }
          if (msg.document && /^image\//.test(msg.document.mime_type || '')) {
            imageSpecs.push({ fileId: msg.document.file_id, mediaType: msg.document.mime_type });
          }
          const images = [];
          for (const spec of imageSpecs) {
            try {
              const f = await tgRequest(this.token, 'getFile', { file_id: spec.fileId });
              const buf = await tgDownloadFile(this.token, f.file_path);
              if (buf.length > 5 * 1024 * 1024) { console.error(`[tg] image too large (${buf.length} bytes) — skipping`); continue; }
              images.push({ mediaType: spec.mediaType, data: buf.toString('base64') });
            } catch (e) { console.error(`[tg] image fetch: ${e.message}`); }
          }
          // Text-ish document attachment (non-image document): inline its contents.
          const TEXT_EXT = /\.(txt|md|markdown|json|jsonl|csv|tsv|log|py|js|mjs|cjs|ts|tsx|jsx|html|htm|css|scss|yaml|yml|toml|ini|cfg|conf|sh|bash|zsh|xml|sql|rs|go|rb|java|kt|swift|php|pl|lua|dockerfile|env)$/i;
          let docText = '';
          if (msg.document && !/^image\//.test(msg.document.mime_type || '')) {
            // Sanitize: filenames come from the client — a triple-backtick name
            // would escape our code-fence and could inject prompt content.
            const rawName = msg.document.file_name || '';
            const name = rawName.replace(/[`\r\n\t\x00-\x1f\x7f]/g, '_').slice(0, 120);
            const isTextMime = /^text\//.test(msg.document.mime_type || '') || /json|javascript|xml|x-sh/.test(msg.document.mime_type || '');
            const isTextExt = TEXT_EXT.test(name);
            if ((isTextMime || isTextExt) && (msg.document.file_size || 0) <= 200 * 1024) {
              try {
                const f = await tgRequest(this.token, 'getFile', { file_id: msg.document.file_id });
                const buf = await tgDownloadFile(this.token, f.file_path);
                docText = `\n\n[attached file: ${name}]\n\`\`\`\n${buf.toString('utf8').slice(0, 180_000)}\n\`\`\``;
              } catch (e) { console.error(`[tg] doc fetch: ${e.message}`); }
            } else if (msg.document) {
              docText = `\n\n[attached non-text file: ${name} (${msg.document.mime_type}, ${msg.document.file_size}B) — can't read this format yet]`;
            }
          }
          // Voice/audio — transcribe if STT configured.
          let voiceNote = '';
          const voiceMeta = msg.voice || msg.audio;
          if (voiceMeta) {
            if (this.transcribe) {
              try {
                const f = await tgRequest(this.token, 'getFile', { file_id: voiceMeta.file_id });
                const buf = await tgDownloadFile(this.token, f.file_path);
                const mime = voiceMeta.mime_type || 'audio/ogg';
                const ext = mime.split('/')[1]?.split(';')[0] || 'ogg';
                const txt = await this.transcribe(buf, mime, `voice.${ext}`);
                voiceNote = txt ? `\n\n[voice transcript] ${txt}` : `\n\n[voice message — empty transcript]`;
              } catch (e) {
                console.error(`[tg] voice transcribe: ${e.message}`);
                voiceNote = `\n\n[voice message received but transcription failed: ${e.message.slice(0, 120)}]`;
              }
            } else {
              voiceNote = `\n\n[voice/audio message — transcription not configured (add cfg.stt.provider+apiKey to enable)]`;
            }
          }
          let text = msg.text || msg.caption || '';
          text = (text + docText + voiceNote).trim();
          if (!text && !images.length) continue;
          // Priority commands: handled IMMEDIATELY, even if another message handler is running.
          // These never enter the onMessage queue.
          const PRIORITY = /^\/(stop|btw|busy|errors|cc|cd|pwd|ls|cat|git|continue|end|sessions|budget)\b/;
          if (PRIORITY.test(text) && this.onPriorityCommand) {
            // Only /stop and /btw are truly fast — for them we await so the
            // poll loop's next cycle sees the updated state. Everything else
            // (esp. /cc which can run a long subprocess) dispatches
            // fire-and-forget so it doesn't block polling → /stop stays
            // responsive mid-chain.
            const fastAwait = /^\/(stop|btw)\b/.test(text);
            const run = async () => {
              try { await this.onPriorityCommand({ chatId: msg.chat.id, fromId, text, bot: this }); }
              catch (e) { console.error(`[tg] priority: ${e.message}`); }
            };
            if (fastAwait) await run();
            else run();
            continue;
          }
          // Extract reply/quote context if present.
          const replyTo = msg.reply_to_message?.text || msg.reply_to_message?.caption || null;
          const replyFrom = msg.reply_to_message?.from?.username || msg.reply_to_message?.from?.first_name || null;
          const quote = msg.quote?.text || null;
          // If a handler is already running, queue this message to be processed after.
          // This keeps the poll loop free to receive /stop and /btw.
          if (this._handlerBusy) {
            this._pendingMessages = this._pendingMessages || [];
            this._pendingMessages.push({ chatId: msg.chat.id, fromId, text: text || '', images, replyTo, replyFrom, quote });
            continue;
          }
          this._handlerBusy = true;
          this._runHandler({ chatId: msg.chat.id, fromId, text: text || '', images, replyTo, replyFrom, quote });
        }
      } catch (e) {
        if (/Conflict:\s*terminated by other getUpdates/i.test(e.message)) {
          console.error('[tg] another instance is polling — this one is exiting so only one remains');
          this.running = false;
          process.exit(1);
        }
        // Suppress noisy-but-harmless poll timeouts and transient gateway errors.
        // Only log genuine poll errors.
        if (/timeout/i.test(e.message)) { /* normal — 30s long-poll cycle, no news */ }
        else if (/bad gateway|service unavailable|502|503/i.test(e.message)) {
          console.error(`[tg] poll: transient ${e.message.slice(0, 80)} — retrying`);
        }
        else { console.error(`[tg] poll: ${e.message}`); }
        this.backoff = Math.min(30, (this.backoff || 1) * 2);
        await new Promise(r => setTimeout(r, this.backoff * 1000));
      }
    }
  }

  _runHandler(msgCtx) {
    // Run this message, then drain any messages that arrived while we were
    // busy. Implemented as a single async while-loop (not recursive) so deep
    // queues don't create unbounded promise nesting.
    (async () => {
      let current = msgCtx;
      while (current) {
        try { await this.onMessage({ ...current, bot: this }); }
        catch (e) {
          console.error(`[tg] handler: ${e.message}`);
          try { await this.send(current.chatId, `error: ${scrubMessage(e).slice(0, 500)}`); } catch {}
        }
        current = (this._pendingMessages && this._pendingMessages.length)
          ? this._pendingMessages.shift()
          : null;
      }
      this._handlerBusy = false;
    })();
  }

  stop() { this.running = false; }
}

module.exports = { TelegramBot };
