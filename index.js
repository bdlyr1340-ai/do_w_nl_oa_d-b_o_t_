require('dotenv').config();
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { Telegraf, Markup } = require('telegraf');

const execFileAsync = promisify(execFile);

const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_RIGHTS = process.env.BOT_RIGHTS || '@VidSave_ProBot';
const TMP_DIR = process.env.TMP_DIR || path.join(__dirname, 'downloads');
const MAX_FILE_SIZE_MB = Number(process.env.MAX_FILE_SIZE_MB || 48);
const PORT = Number(process.env.PORT || 3000);
const USE_WEBHOOK = String(process.env.USE_WEBHOOK || 'false') === 'true';
const WEBHOOK_DOMAIN = process.env.WEBHOOK_DOMAIN || '';
const WEBHOOK_PATH = process.env.WEBHOOK_PATH || '/telegram-webhook';
const YTDLP_PATH = process.env.YTDLP_PATH || 'yt-dlp';
const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 30000);
const PROVIDER_RETRY_COUNT = Number(process.env.PROVIDER_RETRY_COUNT || 1);
const COBALT_API_URL = process.env.COBALT_API_URL || '';
const COBALT_API_KEY = process.env.COBALT_API_KEY || '';
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || '';
const RAPIDAPI_INSTAGRAM_HOST = process.env.RAPIDAPI_INSTAGRAM_HOST || 'instagram-downloader-download-instagram-videos-stories.p.rapidapi.com';
const IG_COOKIES_B64 = process.env.IG_COOKIES_B64 || '';
const IG_COOKIES_URL = process.env.IG_COOKIES_URL || '';
const USER_AGENT = process.env.USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36';

if (!BOT_TOKEN) {
  console.error('Missing BOT_TOKEN');
  process.exit(1);
}

fs.mkdirSync(TMP_DIR, { recursive: true });
const bot = new Telegraf(BOT_TOKEN);
const pendingYoutube = new Map();
let cookiesFilePath = null;

function now() { return Date.now(); }
function log(...args) { console.log(new Date().toISOString(), ...args); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function randomId() { return crypto.randomBytes(8).toString('hex'); }

function ensureCookiesFile() {
  if (cookiesFilePath && fs.existsSync(cookiesFilePath)) return cookiesFilePath;
  if (IG_COOKIES_B64) {
    cookiesFilePath = path.join(TMP_DIR, 'instagram_cookies.txt');
    fs.writeFileSync(cookiesFilePath, Buffer.from(IG_COOKIES_B64, 'base64').toString('utf8'));
    return cookiesFilePath;
  }
  if (IG_COOKIES_URL) {
    throw new Error('IG_COOKIES_URL غير مدعوم داخل الملف الحالي. استخدم IG_COOKIES_B64.');
  }
  return null;
}

function cleanupOldFiles() {
  const maxAgeMs = 1000 * 60 * 60 * 2;
  try {
    for (const name of fs.readdirSync(TMP_DIR)) {
      const p = path.join(TMP_DIR, name);
      const st = fs.statSync(p);
      if (st.isFile() && now() - st.mtimeMs > maxAgeMs) fs.unlinkSync(p);
    }
  } catch (e) {}

  for (const [k, v] of pendingYoutube.entries()) {
    if (now() - v.createdAt > 1000 * 60 * 30) pendingYoutube.delete(k);
  }
}

function isInstagramUrl(text = '') {
  return /https?:\/\/[^\s]*instagram\.com\/(reel|p|stories|share|tv)\/[^\s]+/i.test(text);
}
function isTikTokUrl(text = '') {
  return /https?:\/\/(?:vm\.)?tiktok\.com\/[^\s]+/i.test(text);
}
function isYoutubeUrl(text = '') {
  return /https?:\/\/([^\s]+\.)?(youtube\.com|youtu\.be)\/[^\s]+/i.test(text);
}
function extractUrl(text = '') {
  const m = text.match(/https?:\/\/[^\s]+/i);
  return m ? m[0] : null;
}

function httpRequest(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || undefined,
      path: `${u.pathname}${u.search}`,
      method: options.method || 'GET',
      headers: options.headers || {},
      timeout: REQUEST_TIMEOUT_MS,
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const data = Buffer.concat(chunks);
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const redirectUrl = new URL(res.headers.location, url).toString();
          resolve(httpRequest(redirectUrl, options, body));
          return;
        }
        resolve({ statusCode: res.statusCode, headers: res.headers, body: data });
      });
    });
    req.on('timeout', () => req.destroy(new Error('Request timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function downloadToFile(fileUrl, filePath, headers = {}) {
  const res = await httpRequest(fileUrl, { headers });
  if (res.statusCode !== 200) throw new Error(`Download failed with status ${res.statusCode}`);
  fs.writeFileSync(filePath, res.body);
  return filePath;
}

function getLatestByPrefix(prefix) {
  const files = fs.readdirSync(TMP_DIR)
    .filter(n => n.startsWith(prefix))
    .map(n => path.join(TMP_DIR, n))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (!files.length) throw new Error(`No file found for prefix ${prefix}`);
  return files[0];
}

async function runYtDlp(args) {
  const env = { ...process.env, PATH: process.env.PATH, FFmpegLocation: FFMPEG_PATH };
  return execFileAsync(YTDLP_PATH, args, {
    windowsHide: true,
    maxBuffer: 1024 * 1024 * 30,
    env,
  });
}

function instagramYtdlpArgs(url, prefix, useCookies) {
  const out = path.join(TMP_DIR, `${prefix}%(id)s.%(ext)s`);
  const args = [
    '--no-playlist',
    '--no-warnings',
    '--add-header', `User-Agent:${USER_AGENT}`,
    '--add-header', 'Accept-Language:en-US,en;q=0.9',
    '-f', 'best[ext=mp4]/best',
    '-o', out,
    url,
  ];
  const cookies = ensureCookiesFile();
  if (useCookies && cookies) args.unshift('--cookies', cookies);
  return args;
}

async function providerInstagramViaYtdlp(url, useCookies) {
  const prefix = useCookies ? 'igc_' : 'ig_';
  await runYtDlp(instagramYtdlpArgs(url, prefix, useCookies));
  return getLatestByPrefix(prefix);
}

async function providerInstagramViaCobalt(url) {
  if (!COBALT_API_URL) throw new Error('COBALT_API_URL not configured');
  const payload = JSON.stringify({ url, downloadMode: 'auto', filenameStyle: 'pretty', disableMetadata: false });
  const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
  if (COBALT_API_KEY) headers['Authorization'] = `Api-Key ${COBALT_API_KEY}`;
  const res = await httpRequest(COBALT_API_URL, { method: 'POST', headers }, payload);
  if (res.statusCode < 200 || res.statusCode >= 300) throw new Error(`Cobalt status ${res.statusCode}`);
  const json = JSON.parse(res.body.toString('utf8'));
  const mediaUrl = json.url || json.download || json.file || json.files?.[0]?.url;
  if (!mediaUrl) throw new Error(`Cobalt invalid response: ${JSON.stringify(json).slice(0, 300)}`);
  const ext = (json.filename || '').endsWith('.mp3') ? '.mp3' : '.mp4';
  const out = path.join(TMP_DIR, `cobalt_ig_${randomId()}${ext}`);
  await downloadToFile(mediaUrl, out, { 'User-Agent': USER_AGENT });
  return out;
}

async function providerInstagramViaRapidApi(url) {
  if (!RAPIDAPI_KEY || !RAPIDAPI_INSTAGRAM_HOST) throw new Error('RapidAPI not configured');
  const endpoint = `https://${RAPIDAPI_INSTAGRAM_HOST}/index?url=${encodeURIComponent(url)}`;
  const res = await httpRequest(endpoint, {
    method: 'GET',
    headers: {
      'X-RapidAPI-Key': RAPIDAPI_KEY,
      'X-RapidAPI-Host': RAPIDAPI_INSTAGRAM_HOST,
      'User-Agent': USER_AGENT,
      'Accept': 'application/json'
    }
  });
  if (res.statusCode < 200 || res.statusCode >= 300) throw new Error(`RapidAPI status ${res.statusCode}`);
  const json = JSON.parse(res.body.toString('utf8'));
  const mediaUrl = json.media || json.url || json.download_url || json.video_url || json.result?.url || json.result?.video;
  if (!mediaUrl) throw new Error(`RapidAPI invalid response: ${JSON.stringify(json).slice(0, 300)}`);
  const out = path.join(TMP_DIR, `rapid_ig_${randomId()}.mp4`);
  await downloadToFile(mediaUrl, out, { 'User-Agent': USER_AGENT, 'Referer': 'https://www.instagram.com/' });
  return out;
}

async function providerTikTokViaTikwm(url) {
  const form = `url=${encodeURIComponent(url)}`;
  const res = await httpRequest('https://www.tikwm.com/api/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(form),
      'User-Agent': USER_AGENT,
      'Accept': 'application/json'
    }
  }, form);
  const json = JSON.parse(res.body.toString('utf8'));
  if (json.code !== 0 || !json.data?.play) throw new Error(`tikwm failed: ${JSON.stringify(json).slice(0, 200)}`);
  const out = path.join(TMP_DIR, `tt_${randomId()}.mp4`);
  await downloadToFile(json.data.play, out, { 'User-Agent': USER_AGENT, 'Referer': 'https://www.tiktok.com/' });
  return out;
}

async function providerTikTokViaCobalt(url) {
  if (!COBALT_API_URL) throw new Error('COBALT_API_URL not configured');
  const payload = JSON.stringify({ url, downloadMode: 'auto', filenameStyle: 'pretty' });
  const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
  if (COBALT_API_KEY) headers['Authorization'] = `Api-Key ${COBALT_API_KEY}`;
  const res = await httpRequest(COBALT_API_URL, { method: 'POST', headers }, payload);
  if (res.statusCode < 200 || res.statusCode >= 300) throw new Error(`Cobalt status ${res.statusCode}`);
  const json = JSON.parse(res.body.toString('utf8'));
  const mediaUrl = json.url || json.download || json.file || json.files?.[0]?.url;
  if (!mediaUrl) throw new Error(`Cobalt invalid response: ${JSON.stringify(json).slice(0, 200)}`);
  const out = path.join(TMP_DIR, `tt_cb_${randomId()}.mp4`);
  await downloadToFile(mediaUrl, out, { 'User-Agent': USER_AGENT });
  return out;
}

async function providerYoutubeMp4(url) {
  const out = path.join(TMP_DIR, 'yt_vid_%(id)s.%(ext)s');
  await runYtDlp(['-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best', '--merge-output-format', 'mp4', '--no-playlist', '-o', out, url]);
  return getLatestByPrefix('yt_vid_');
}

async function providerYoutubeMp3(url) {
  const out = path.join(TMP_DIR, 'yt_audio_%(id)s.%(ext)s');
  await runYtDlp(['-x', '--audio-format', 'mp3', '--audio-quality', '0', '--no-playlist', '-o', out, url]);
  return getLatestByPrefix('yt_audio_');
}

function fileSizeMb(filePath) {
  return fs.statSync(filePath).size / 1024 / 1024;
}

async function sendVideoFile(ctx, filePath, caption) {
  const size = fileSizeMb(filePath);
  if (size > MAX_FILE_SIZE_MB) throw new Error(`حجم الملف ${size.toFixed(2)}MB أكبر من الحد ${MAX_FILE_SIZE_MB}MB`);
  await ctx.replyWithVideo({ source: filePath }, { caption, supports_streaming: true });
}

async function sendAudioFile(ctx, filePath, caption) {
  const size = fileSizeMb(filePath);
  if (size > MAX_FILE_SIZE_MB) throw new Error(`حجم الملف ${size.toFixed(2)}MB أكبر من الحد ${MAX_FILE_SIZE_MB}MB`);
  await ctx.replyWithAudio({ source: filePath }, { caption });
}

function cleanupFile(file) {
  try { if (file && fs.existsSync(file)) fs.unlinkSync(file); } catch (e) {}
}

async function tryProviders(label, providers) {
  const errors = [];
  for (const p of providers) {
    for (let attempt = 1; attempt <= PROVIDER_RETRY_COUNT + 1; attempt++) {
      try {
        log(label, 'provider=', p.name, 'attempt=', attempt);
        const result = await p.run();
        return { filePath: result, provider: p.name, errors };
      } catch (e) {
        const msg = `${p.name} failed: ${e.message}`;
        errors.push(msg);
        log(label, msg);
        if (attempt <= PROVIDER_RETRY_COUNT) await sleep(1000 * attempt);
      }
    }
  }
  const err = new Error(errors.join('\n'));
  err.allErrors = errors;
  throw err;
}

bot.start(async (ctx) => {
  cleanupOldFiles();
  await ctx.reply(
    `أهلاً بك في بوت التحميل الذكي 🚀\n\n` +
    `- أرسل رابط TikTok للتحميل المباشر\n` +
    `- أرسل رابط Instagram Reel/Post/Story للتحميل\n` +
    `- أرسل رابط YouTube لاختيار MP3 أو MP4\n\n` +
    `بواسطة: ${BOT_RIGHTS}`
  );
});

bot.on('text', async (ctx) => {
  cleanupOldFiles();
  const text = (ctx.message.text || '').trim();
  const url = extractUrl(text);
  if (!url) {
    await ctx.reply('❌ أرسل رابطًا صحيحًا من Instagram أو TikTok أو YouTube.');
    return;
  }

  if (isYoutubeUrl(url)) {
    const key = randomId();
    pendingYoutube.set(key, { url, createdAt: now() });
    await ctx.reply('لقد أرسلت رابط يوتيوب، اختر الصيغة المطلوبة:', Markup.inlineKeyboard([
      [
        Markup.button.callback('تحميل صوت (MP3) 🎵', `mp3:${key}`),
        Markup.button.callback('تحميل فيديو (MP4) 🎬', `mp4:${key}`)
      ]
    ]));
    return;
  }

  if (isTikTokUrl(url)) {
    const waitMsg = await ctx.reply('جاري سحب فيديو تيك توك... ⚡');
    let filePath = null;
    try {
      const result = await tryProviders('tiktok', [
        { name: 'tikwm', run: () => providerTikTokViaTikwm(url) },
        { name: 'cobalt', run: () => providerTikTokViaCobalt(url) },
      ]);
      filePath = result.filePath;
      await sendVideoFile(ctx, filePath, `✅ تم تحميل الفيديو بواسطة: ${BOT_RIGHTS}\nالمصدر: ${result.provider}`);
      await ctx.deleteMessage(waitMsg.message_id).catch(() => {});
    } catch (e) {
      await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined,
        `❌ فشل تحميل TikTok.\n${String(e.message).slice(0, 3500)}`
      ).catch(async () => ctx.reply(`❌ فشل تحميل TikTok.\n${String(e.message).slice(0, 3500)}`));
    } finally {
      cleanupFile(filePath);
    }
    return;
  }

  if (isInstagramUrl(url)) {
    const waitMsg = await ctx.reply('جاري سحب فيديو إنستغرام... ⏳');
    let filePath = null;
    try {
      const providers = [];
      if (RAPIDAPI_KEY) providers.push({ name: 'rapidapi-instagram', run: () => providerInstagramViaRapidApi(url) });
      if (COBALT_API_URL) providers.push({ name: 'cobalt', run: () => providerInstagramViaCobalt(url) });
      if (ensureCookiesFile()) providers.push({ name: 'yt-dlp-with-cookies', run: () => providerInstagramViaYtdlp(url, true) });
      providers.push({ name: 'yt-dlp-no-cookies', run: () => providerInstagramViaYtdlp(url, false) });

      const result = await tryProviders('instagram', providers);
      filePath = result.filePath;
      const ext = path.extname(filePath).toLowerCase();
      if (ext === '.mp3') {
        await sendAudioFile(ctx, filePath, `✅ تم التحميل بواسطة: ${BOT_RIGHTS}\nالمصدر: ${result.provider}`);
      } else {
        await sendVideoFile(ctx, filePath, `✅ تم التحميل بواسطة: ${BOT_RIGHTS}\nالمصدر: ${result.provider}`);
      }
      await ctx.deleteMessage(waitMsg.message_id).catch(() => {});
    } catch (e) {
      const hasCookieHint = /login required|rate-limit|cookies|authentication/i.test(String(e.message));
      const extra = hasCookieHint
        ? '\n\nالحل الجذري لهذا الرابط: أضف IG_COOKIES_B64 أو فعّل مزود احتياطي مثل COBALT_API_URL أو RapidAPI.'
        : '';
      await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined,
        `❌ فشل تحميل Instagram.${extra}\n${String(e.message).slice(0, 3300)}`
      ).catch(async () => ctx.reply(`❌ فشل تحميل Instagram.${extra}\n${String(e.message).slice(0, 3300)}`));
    } finally {
      cleanupFile(filePath);
    }
    return;
  }

  await ctx.reply('❌ هذا الرابط غير مدعوم.');
});

bot.action(/^(mp3|mp4):([a-f0-9]+)$/i, async (ctx) => {
  cleanupOldFiles();
  await ctx.answerCbQuery('جاري التحميل...');
  const action = ctx.match[1];
  const key = ctx.match[2];
  const item = pendingYoutube.get(key);
  if (!item) {
    await ctx.reply('❌ انتهت صلاحية الرابط. أرسله من جديد.');
    return;
  }
  const waitMsg = await ctx.reply('جاري معالجة طلب يوتيوب... ⏳');
  let filePath = null;
  try {
    filePath = action === 'mp3' ? await providerYoutubeMp3(item.url) : await providerYoutubeMp4(item.url);
    if (action === 'mp3') {
      await sendAudioFile(ctx, filePath, `✅ تم تحميل الصوت بواسطة: ${BOT_RIGHTS}`);
    } else {
      await sendVideoFile(ctx, filePath, `✅ تم تحميل الفيديو بواسطة: ${BOT_RIGHTS}`);
    }
    await ctx.deleteMessage(waitMsg.message_id).catch(() => {});
  } catch (e) {
    await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined,
      `❌ حدث خطأ في YouTube.\n${String(e.message).slice(0, 3500)}`
    ).catch(async () => ctx.reply(`❌ حدث خطأ في YouTube.\n${String(e.message).slice(0, 3500)}`));
  } finally {
    cleanupFile(filePath);
  }
});

bot.catch((err) => {
  console.error('BOT_ERROR', err);
});

async function verifyBinary(name, args = ['--version']) {
  try {
    const r = await execFileAsync(name, args, { windowsHide: true });
    log(name, 'OK', (r.stdout || r.stderr || '').toString().trim().split('\n')[0]);
  } catch (e) {
    console.error(`Missing dependency: ${name}`);
    process.exit(1);
  }
}

async function start() {
  cleanupOldFiles();
  await verifyBinary(YTDLP_PATH, ['--version']);
  await verifyBinary(FFMPEG_PATH, ['-version']);

  if (USE_WEBHOOK && WEBHOOK_DOMAIN) {
    await bot.launch({ webhook: { domain: WEBHOOK_DOMAIN, hookPath: WEBHOOK_PATH, port: PORT } });
    log(`Bot running with webhook ${WEBHOOK_DOMAIN}${WEBHOOK_PATH}`);
  } else {
    await bot.launch();
    log('Bot running with long polling');
  }
}

start().catch((err) => {
  console.error('Startup error:', err);
  process.exit(1);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
