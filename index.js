require('dotenv').config();
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { Telegraf, Markup } = require('telegraf');

const execFileAsync = promisify(execFile);

const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_RIGHTS = process.env.BOT_RIGHTS || '@VidSave_ProBot';
const TMP_DIR = process.env.TMP_DIR || path.join(__dirname, 'downloads');
const MAX_FILE_SIZE_MB = Number(process.env.MAX_FILE_SIZE_MB || 48);
const PORT = Number(process.env.PORT || 3000);
const YTDLP_PATH = process.env.YTDLP_PATH || 'yt-dlp';
const USE_WEBHOOK = String(process.env.USE_WEBHOOK || 'false') === 'true';
const WEBHOOK_DOMAIN = process.env.WEBHOOK_DOMAIN || '';
const WEBHOOK_PATH = process.env.WEBHOOK_PATH || '/telegram-webhook';
const COBALT_API_URL = process.env.COBALT_API_URL || '';
const COBALT_API_KEY = process.env.COBALT_API_KEY || '';
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || '';
const RAPIDAPI_INSTAGRAM_HOST = process.env.RAPIDAPI_INSTAGRAM_HOST || 'instagram-downloader-download-instagram-videos-stories.p.rapidapi.com';
const IG_COOKIES_B64 = process.env.IG_COOKIES_B64 || '';
const IG_COOKIES_URL = process.env.IG_COOKIES_URL || '';
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 30000);
const PROVIDER_RETRY_COUNT = Number(process.env.PROVIDER_RETRY_COUNT || 1);

if (!BOT_TOKEN) {
  console.error('Missing BOT_TOKEN');
  process.exit(1);
}

fs.mkdirSync(TMP_DIR, { recursive: true });
const bot = new Telegraf(BOT_TOKEN);
const pendingYoutube = new Map();
const userLocks = new Map();
const sessionMemory = new Map();

function log(...args) { console.log(new Date().toISOString(), ...args); }

function lockUser(userId) {
  if (userLocks.get(userId)) return false;
  userLocks.set(userId, true);
  return true;
}
function unlockUser(userId) { userLocks.delete(userId); }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function randomId() { return Math.random().toString(36).slice(2, 10); }
function now() { return Date.now(); }

function isTikTokUrl(text = '') {
  return /https?:\/\/([^\s]+\.)?(tiktok\.com|vm\.tiktok\.com)\/[^
\s]+/i.test(text);
}
function isInstagramUrl(text = '') {
  return /https?:\/\/([^\s]+\.)?instagram\.com\/[^
\s]+/i.test(text);
}
function isInstagramStoryUrl(text = '') {
  return /instagram\.com\/(stories|s)\//i.test(text);
}
function isYoutubeUrl(text = '') {
  return /https?:\/\/([^\s]+\.)?(youtube\.com|youtu\.be)\/[^
\s]+/i.test(text);
}
function extractUrl(text = '') {
  const match = text.match(/https?:\/\/[^\s]+/i);
  return match ? match[0] : null;
}

function fileSizeMb(filePath) {
  return fs.statSync(filePath).size / 1024 / 1024;
}
function removeSafe(filePath) {
  try { if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (_) {}
}
function cleanupOldFiles() {
  try {
    const cutoff = now() - 1000 * 60 * 60;
    for (const name of fs.readdirSync(TMP_DIR)) {
      const full = path.join(TMP_DIR, name);
      const stat = fs.statSync(full);
      if (stat.isFile() && stat.mtimeMs < cutoff) removeSafe(full);
    }
  } catch (e) { log('cleanupOldFiles error', e.message); }
}
function cleanupMemories() {
  const cutoff = now() - 1000 * 60 * 30;
  for (const [k, v] of pendingYoutube.entries()) if (v.createdAt < cutoff) pendingYoutube.delete(k);
  for (const [k, v] of sessionMemory.entries()) if (v.createdAt < cutoff) sessionMemory.delete(k);
}

function makeTempFile(prefix, ext = '.tmp') {
  return path.join(TMP_DIR, `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
}

function request(url, options = {}, responseType = 'text') {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const lib = target.protocol === 'https:' ? https : http;
    const req = lib.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      path: target.pathname + target.search,
      method: options.method || 'GET',
      headers: options.headers || {},
      timeout: options.timeout || REQUEST_TIMEOUT_MS
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(request(res.headers.location, options, responseType));
        return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve({
          statusCode: res.statusCode || 0,
          headers: res.headers,
          body: responseType === 'buffer' ? buffer : buffer.toString('utf8')
        });
      });
    });
    req.on('timeout', () => req.destroy(new Error('Request timeout')));
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function downloadToFile(url, destination, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const lib = target.protocol === 'https:' ? https : http;
    const file = fs.createWriteStream(destination);
    const req = lib.get(url, { headers: extraHeaders, timeout: REQUEST_TIMEOUT_MS }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        removeSafe(destination);
        downloadToFile(res.headers.location, destination, extraHeaders).then(resolve).catch(reject);
        return;
      }
      if ((res.statusCode || 0) >= 400) {
        file.close();
        removeSafe(destination);
        reject(new Error(`Download failed with status ${res.statusCode}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(destination)));
    });
    req.on('timeout', () => req.destroy(new Error('Download timeout')));
    req.on('error', (err) => { file.close(); removeSafe(destination); reject(err); });
  });
}

async function runCmd(cmd, args, opts = {}) {
  const { stdout, stderr } = await execFileAsync(cmd, args, {
    windowsHide: true,
    maxBuffer: 1024 * 1024 * 20,
    timeout: opts.timeout || REQUEST_TIMEOUT_MS * 4,
    env: { ...process.env, ...(opts.env || {}) }
  });
  return { stdout, stderr };
}

async function ensureDependencies() {
  await runCmd(YTDLP_PATH, ['--version']);
  await runCmd('ffmpeg', ['-version']);
  if (IG_COOKIES_B64) {
    const cookiesPath = path.join(TMP_DIR, 'instagram_cookies.txt');
    fs.writeFileSync(cookiesPath, Buffer.from(IG_COOKIES_B64, 'base64'));
  } else if (IG_COOKIES_URL) {
    const cookiesPath = path.join(TMP_DIR, 'instagram_cookies.txt');
    const res = await request(IG_COOKIES_URL, {}, 'buffer');
    if (res.statusCode >= 200 && res.statusCode < 300) fs.writeFileSync(cookiesPath, res.body);
  }
}

function getCookiesPath() {
  const p = path.join(TMP_DIR, 'instagram_cookies.txt');
  return fs.existsSync(p) ? p : '';
}

function getLatestMatchingFile(prefix) {
  const files = fs.readdirSync(TMP_DIR)
    .filter(name => name.startsWith(prefix))
    .map(name => path.join(TMP_DIR, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (!files.length) throw new Error(`No file found for prefix: ${prefix}`);
  return files[0];
}

async function sendFileByType(ctx, filePath, type, caption) {
  const sizeMb = fileSizeMb(filePath);
  if (sizeMb > MAX_FILE_SIZE_MB) {
    throw new Error(`حجم الملف ${sizeMb.toFixed(2)}MB أكبر من الحد المسموح ${MAX_FILE_SIZE_MB}MB`);
  }
  if (type === 'audio') {
    await ctx.replyWithAudio({ source: filePath }, { caption });
  } else {
    await ctx.replyWithVideo({ source: filePath }, { caption });
  }
}

async function providerTry(name, fn) {
  let lastErr = null;
  for (let attempt = 0; attempt <= PROVIDER_RETRY_COUNT; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      log(`Provider ${name} failed attempt ${attempt + 1}:`, e.message);
      if (attempt < PROVIDER_RETRY_COUNT) await sleep(500);
    }
  }
  throw new Error(`${name}: ${lastErr ? lastErr.message : 'unknown error'}`);
}

async function tiktokViaTikWM(url) {
  const body = `url=${encodeURIComponent(url)}`;
  const res = await request('https://www.tikwm.com/api/', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'content-length': Buffer.byteLength(body)
    },
    body
  });
  const json = JSON.parse(res.body || '{}');
  const direct = json?.data?.play || json?.data?.wmplay;
  if (!direct) throw new Error('TikWM returned no playable URL');
  const ext = '.mp4';
  const file = makeTempFile('tiktok', ext);
  await downloadToFile(direct, file, { referer: 'https://www.tikwm.com/' });
  return { type: 'video', filePath: file, provider: 'TikWM' };
}

async function viaCobalt(url, want = 'video') {
  if (!COBALT_API_URL) throw new Error('COBALT_API_URL not configured');
  const body = JSON.stringify({
    url,
    downloadMode: 'auto',
    videoQuality: '1080',
    audioFormat: want === 'audio' ? 'mp3' : undefined,
    youtubeVideoCodec: 'h264',
    filenameStyle: 'basic',
    disableMetadata: false,
    alwaysProxy: false
  });
  const headers = { 'content-type': 'application/json' };
  if (COBALT_API_KEY) headers.authorization = `Api-Key ${COBALT_API_KEY}`;
  const res = await request(COBALT_API_URL.replace(/\/$/, '') + '/', { method: 'POST', headers, body });
  const json = JSON.parse(res.body || '{}');
  const dl = json?.url || json?.download?.url;
  if (!dl) throw new Error(json?.text || json?.error?.code || 'Cobalt returned no URL');
  const ext = want === 'audio' ? '.mp3' : '.mp4';
  const file = makeTempFile(`cobalt_${want}`, ext);
  await downloadToFile(dl, file);
  return { type: want === 'audio' ? 'audio' : 'video', filePath: file, provider: 'Cobalt' };
}

async function instagramViaRapidApi(url) {
  if (!RAPIDAPI_KEY) throw new Error('RAPIDAPI_KEY not configured');
  const apiUrl = `https://${RAPIDAPI_INSTAGRAM_HOST}/?url=${encodeURIComponent(url)}`;
  const res = await request(apiUrl, {
    headers: {
      'x-rapidapi-key': RAPIDAPI_KEY,
      'x-rapidapi-host': RAPIDAPI_INSTAGRAM_HOST
    }
  });
  const json = JSON.parse(res.body || '{}');
  const candidates = [];
  if (typeof json?.media === 'string') candidates.push(json.media);
  if (Array.isArray(json?.media)) candidates.push(...json.media.map(x => typeof x === 'string' ? x : x?.url).filter(Boolean));
  if (typeof json?.download_url === 'string') candidates.push(json.download_url);
  if (typeof json?.url === 'string') candidates.push(json.url);
  if (json?.data) {
    if (typeof json.data?.url === 'string') candidates.push(json.data.url);
    if (Array.isArray(json.data?.media)) candidates.push(...json.data.media.map(x => typeof x === 'string' ? x : x?.url).filter(Boolean));
  }
  const best = candidates.find(Boolean);
  if (!best) throw new Error('RapidAPI returned no downloadable media');
  const file = makeTempFile('instagram_api', '.mp4');
  await downloadToFile(best, file);
  return { type: 'video', filePath: file, provider: 'RapidAPI Instagram' };
}

async function ytDlpDownload(url, mode = 'video', source = 'generic', useCookies = false) {
  const prefix = `${source}_${mode}_${Date.now()}_`;
  const template = path.join(TMP_DIR, `${prefix}%(id)s.%(ext)s`);
  const args = ['--no-playlist', '-o', template];
  if (mode === 'audio') {
    args.push('-x', '--audio-format', 'mp3');
  } else {
    args.push('-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best');
    args.push('--merge-output-format', 'mp4');
  }
  if (useCookies && getCookiesPath()) args.push('--cookies', getCookiesPath());
  args.push(url);
  await runCmd(YTDLP_PATH, args, { timeout: REQUEST_TIMEOUT_MS * 6 });
  const files = fs.readdirSync(TMP_DIR)
    .filter(name => name.startsWith(prefix))
    .map(name => path.join(TMP_DIR, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (!files.length) throw new Error('yt-dlp produced no file');
  return { type: mode === 'audio' ? 'audio' : 'video', filePath: files[0], provider: `yt-dlp${useCookies ? ' + cookies' : ''}` };
}

async function handleInstagramDownload(url) {
  const isStory = isInstagramStoryUrl(url);
  const tasks = [];
  if (RAPIDAPI_KEY) tasks.push(() => providerTry('RapidAPI Instagram', () => instagramViaRapidApi(url)));
  if (COBALT_API_URL) tasks.push(() => providerTry('Cobalt', () => viaCobalt(url, 'video')));
  if (getCookiesPath()) tasks.push(() => providerTry('yt-dlp cookies', () => ytDlpDownload(url, 'video', 'instagram', true)));
  tasks.push(() => providerTry('yt-dlp', () => ytDlpDownload(url, 'video', 'instagram', false)));

  let lastError = null;
  for (const task of tasks) {
    try { return await task(); } catch (e) { lastError = e; }
  }
  if (isStory && !getCookiesPath()) {
    throw new Error('فشل تحميل الستوري. غالبًا تحتاج Instagram cookies لأن الستوري كثيرًا ما تتطلب تسجيل دخول أو تتأثر بالـ rate limit. آخر خطأ: ' + (lastError?.message || 'unknown'));
  }
  throw lastError || new Error('Instagram download failed');
}

async function handleTikTokDownload(url) {
  const tasks = [
    () => providerTry('TikWM', () => tiktokViaTikWM(url)),
    ...(COBALT_API_URL ? [() => providerTry('Cobalt', () => viaCobalt(url, 'video'))] : []),
    () => providerTry('yt-dlp', () => ytDlpDownload(url, 'video', 'tiktok', false))
  ];
  let lastError = null;
  for (const task of tasks) {
    try { return await task(); } catch (e) { lastError = e; }
  }
  throw lastError || new Error('TikTok download failed');
}

async function handleYoutubeDownload(url, mode) {
  const tasks = [];
  if (mode === 'video' && COBALT_API_URL) tasks.push(() => providerTry('Cobalt', () => viaCobalt(url, 'video')));
  tasks.push(() => providerTry('yt-dlp', () => ytDlpDownload(url, mode === 'audio' ? 'audio' : 'video', 'youtube', false)));
  let lastError = null;
  for (const task of tasks) {
    try { return await task(); } catch (e) { lastError = e; }
  }
  throw lastError || new Error('YouTube download failed');
}

function makeYoutubeButtons(url) {
  const key = randomId();
  pendingYoutube.set(key, { url, createdAt: now() });
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('تحميل صوت (MP3) 🎵', `yt:audio:${key}`),
      Markup.button.callback('تحميل فيديو (MP4) 🎬', `yt:video:${key}`)
    ]
  ]);
}

async function processMessageUrl(ctx, url) {
  const userId = ctx.from.id;
  if (!lockUser(userId)) {
    await ctx.reply('⏳ لديك عملية جارية بالفعل. انتظر انتهائها أولًا.');
    return;
  }
  let waitMsg = null;
  let result = null;
  try {
    if (isTikTokUrl(url)) {
      waitMsg = await ctx.reply('جاري تحميل فيديو تيك توك... ⚡');
      result = await handleTikTokDownload(url);
      await sendFileByType(ctx, result.filePath, result.type, `✅ تم التحميل بواسطة: ${BOT_RIGHTS}\nالمصدر: ${result.provider}`);
    } else if (isInstagramUrl(url)) {
      waitMsg = await ctx.reply(isInstagramStoryUrl(url) ? 'جاري تحميل ستوري إنستغرام... ⏳' : 'جاري تحميل فيديو إنستغرام... ⏳');
      result = await handleInstagramDownload(url);
      await sendFileByType(ctx, result.filePath, result.type, `✅ تم التحميل بواسطة: ${BOT_RIGHTS}\nالمصدر: ${result.provider}`);
    } else if (isYoutubeUrl(url)) {
      await ctx.reply('لقد أرسلت رابط يوتيوب، اختر الصيغة المطلوبة:', makeYoutubeButtons(url));
      return;
    } else {
      await ctx.reply('❌ هذا الرابط غير مدعوم. أرسل رابط TikTok أو Instagram أو YouTube.');
      return;
    }
    if (waitMsg) await ctx.deleteMessage(waitMsg.message_id).catch(() => {});
  } catch (e) {
    const text = `❌ فشل التحميل.\n${e.message}`;
    if (waitMsg) {
      await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, text).catch(async () => {
        await ctx.reply(text);
      });
    } else {
      await ctx.reply(text);
    }
  } finally {
    if (result?.filePath) removeSafe(result.filePath);
    unlockUser(userId);
  }
}

bot.start(async (ctx) => {
  cleanupOldFiles();
  cleanupMemories();
  await ctx.reply(
    `أهلاً بك في بوت التحميل الذكي 🚀\n\n` +
    `• TikTok: تحميل مباشر\n` +
    `• Instagram / Reels / Posts / Stories: تحميل مباشر مع بدائل احتياطية\n` +
    `• YouTube: اختيار MP3 أو MP4\n\n` +
    `بواسطة: ${BOT_RIGHTS}`
  );
});

bot.command('help', async (ctx) => {
  await ctx.reply(
    `الاستخدام:\n` +
    `1) أرسل رابط TikTok أو Instagram أو YouTube\n` +
    `2) يوتيوب يعطيك أزرار MP3 / MP4\n` +
    `3) إنستغرام ستوري قد يحتاج Cookies إذا كان المحتوى مقيّدًا أو حصل rate-limit\n\n` +
    `بواسطة: ${BOT_RIGHTS}`
  );
});

bot.command('status', async (ctx) => {
  const hasCookies = !!getCookiesPath();
  await ctx.reply(
    `الحالة الحالية:\n` +
    `yt-dlp: ${YTDLP_PATH}\n` +
    `Cobalt: ${COBALT_API_URL ? 'مفعّل' : 'غير مفعّل'}\n` +
    `RapidAPI Instagram: ${RAPIDAPI_KEY ? 'مفعّل' : 'غير مفعّل'}\n` +
    `Instagram Cookies: ${hasCookies ? 'موجودة' : 'غير موجودة'}\n` +
    `Webhook: ${USE_WEBHOOK ? 'مفعّل' : 'غير مفعّل'}`
  );
});

bot.on('text', async (ctx) => {
  cleanupOldFiles();
  cleanupMemories();
  const text = (ctx.message.text || '').trim();
  const url = extractUrl(text);
  if (!url) {
    await ctx.reply('❌ أرسل رابطًا صحيحًا من TikTok أو Instagram أو YouTube.');
    return;
  }
  await processMessageUrl(ctx, url);
});

bot.action(/^yt:(audio|video):([a-z0-9]+)$/i, async (ctx) => {
  cleanupOldFiles();
  cleanupMemories();
  await ctx.answerCbQuery('جاري التحميل...');
  const mode = ctx.match[1];
  const key = ctx.match[2];
  const entry = pendingYoutube.get(key);
  if (!entry?.url) {
    await ctx.reply('❌ انتهت صلاحية هذا الزر. أرسل رابط يوتيوب من جديد.');
    return;
  }
  const userId = ctx.from.id;
  if (!lockUser(userId)) {
    await ctx.reply('⏳ لديك عملية جارية بالفعل. انتظر انتهائها أولًا.');
    return;
  }
  let waitMsg = null;
  let result = null;
  try {
    waitMsg = await ctx.reply('جاري معالجة طلبك من يوتيوب... ⏳');
    result = await handleYoutubeDownload(entry.url, mode);
    await sendFileByType(ctx, result.filePath, result.type, `✅ تم التحميل بواسطة: ${BOT_RIGHTS}\nالمصدر: ${result.provider}`);
    await ctx.deleteMessage(waitMsg.message_id).catch(() => {});
  } catch (e) {
    const text = `❌ حدث خطأ أثناء تحميل يوتيوب.\n${e.message}`;
    if (waitMsg) {
      await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, text).catch(async () => {
        await ctx.reply(text);
      });
    } else {
      await ctx.reply(text);
    }
  } finally {
    if (result?.filePath) removeSafe(result.filePath);
    unlockUser(userId);
  }
});

bot.catch((err) => log('Bot error', err));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

(async () => {
  try {
    await ensureDependencies();
    if (USE_WEBHOOK && WEBHOOK_DOMAIN) {
      const hookUrl = `${WEBHOOK_DOMAIN.replace(/\/$/, '')}${WEBHOOK_PATH}`;
      await bot.telegram.setWebhook(hookUrl);
      await bot.launch({ webhook: { domain: WEBHOOK_DOMAIN, hookPath: WEBHOOK_PATH, port: PORT } });
      log(`Bot running with webhook at ${hookUrl}`);
    } else {
      await bot.launch();
      log('Bot running with long polling');
    }
  } catch (e) {
    console.error('Startup error:', e);
    process.exit(1);
  }
})();
