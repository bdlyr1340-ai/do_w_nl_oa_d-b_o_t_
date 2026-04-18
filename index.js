require('dotenv').config();
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { Telegraf, Markup } = require('telegraf');

const execFileAsync = promisify(execFile);

const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_RIGHTS = process.env.BOT_RIGHTS || '@VidSave_ProBot';
const TMP_DIR = process.env.TMP_DIR || path.join(__dirname, 'downloads');
const MAX_FILE_SIZE_MB = Number(process.env.MAX_FILE_SIZE_MB || 48);

if (!BOT_TOKEN) {
  console.error('Missing BOT_TOKEN in environment variables');
  process.exit(1);
}

if (!fs.existsSync(TMP_DIR)) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
}

const bot = new Telegraf(BOT_TOKEN);
const pendingUrls = new Map();

function isTikTokUrl(text = '') {
  return /https?:\/\/[^\s]*tiktok\.com\/[^\s]+/i.test(text) || /https?:\/\/vm\.tiktok\.com\/[^\s]+/i.test(text);
}

function isInstagramUrl(text = '') {
  return /https?:\/\/[^\s]*instagram\.com\/[^\s]+/i.test(text);
}

function isYoutubeUrl(text = '') {
  return /https?:\/\/([^\s]+\.)?(youtube\.com|youtu\.be)\/[^\s]+/i.test(text);
}

function extractUrl(text = '') {
  const match = text.match(/https?:\/\/[^\s]+/i);
  return match ? match[0] : null;
}

function makeRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.request(url, options, (res) => {
      let data = '';

      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(makeRequest(res.headers.location, options));
        return;
      }

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: data
        });
      });
    });

    req.on('error', reject);

    if (options.body) {
      req.write(options.body);
    }

    req.end();
  });
}

function downloadFile(fileUrl, destination) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destination);
    const lib = fileUrl.startsWith('https') ? https : http;

    const request = lib.get(fileUrl, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        file.close();
        fs.unlink(destination, () => {
          downloadFile(response.headers.location, destination).then(resolve).catch(reject);
        });
        return;
      }

      if (response.statusCode !== 200) {
        file.close();
        fs.unlink(destination, () => {});
        reject(new Error(`Failed to download file. Status code: ${response.statusCode}`));
        return;
      }

      response.pipe(file);

      file.on('finish', () => {
        file.close(() => resolve(destination));
      });
    });

    request.on('error', (err) => {
      file.close();
      fs.unlink(destination, () => {});
      reject(err);
    });
  });
}

function removeFileSafe(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (_) {}
}

function cleanupOldFiles() {
  try {
    const now = Date.now();
    const maxAge = 1000 * 60 * 60; // ساعة

    for (const name of fs.readdirSync(TMP_DIR)) {
      const filePath = path.join(TMP_DIR, name);
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > maxAge) {
        removeFileSafe(filePath);
      }
    }
  } catch (_) {}
}

function randomId() {
  return Math.random().toString(36).slice(2, 10);
}

function createYoutubeButtons(url) {
  const key = randomId();
  pendingUrls.set(key, {
    url,
    createdAt: Date.now()
  });

  return {
    key,
    markup: Markup.inlineKeyboard([
      [
        Markup.button.callback('تحميل صوت (MP3) 🎵', `mp3:${key}`),
        Markup.button.callback('تحميل فيديو (MP4) 🎬', `mp4:${key}`)
      ]
    ])
  };
}

function cleanupPendingUrls() {
  const now = Date.now();
  for (const [key, value] of pendingUrls.entries()) {
    if (now - value.createdAt > 1000 * 60 * 30) {
      pendingUrls.delete(key);
    }
  }
}

async function runYtDlp(args) {
  const { stdout, stderr } = await execFileAsync('yt-dlp', args, {
    windowsHide: true,
    maxBuffer: 1024 * 1024 * 20
  });
  return { stdout, stderr };
}

async function downloadInstagramVideo(url) {
  const template = path.join(TMP_DIR, 'ig_%(id)s.%(ext)s');

  await runYtDlp([
    '-f', 'best[ext=mp4]/best',
    '--no-playlist',
    '-o', template,
    url
  ]);

  const files = fs
    .readdirSync(TMP_DIR)
    .filter((name) => name.startsWith('ig_'))
    .map((name) => path.join(TMP_DIR, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

  if (!files.length) {
    throw new Error('لم يتم العثور على ملف إنستغرام بعد التحميل');
  }

  return files[0];
}

async function downloadYoutubeVideo(url) {
  const template = path.join(TMP_DIR, 'yt_vid_%(id)s.%(ext)s');

  await runYtDlp([
    '-f', 'best[ext=mp4]/best',
    '--no-playlist',
    '-o', template,
    url
  ]);

  const files = fs
    .readdirSync(TMP_DIR)
    .filter((name) => name.startsWith('yt_vid_'))
    .map((name) => path.join(TMP_DIR, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

  if (!files.length) {
    throw new Error('لم يتم العثور على ملف فيديو يوتيوب بعد التحميل');
  }

  return files[0];
}

async function downloadYoutubeAudio(url) {
  const template = path.join(TMP_DIR, 'audio_%(id)s.%(ext)s');

  await runYtDlp([
    '-x',
    '--audio-format', 'mp3',
    '--no-playlist',
    '-o', template,
    url
  ]);

  const files = fs
    .readdirSync(TMP_DIR)
    .filter((name) => name.startsWith('audio_'))
    .map((name) => path.join(TMP_DIR, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

  if (!files.length) {
    throw new Error('لم يتم العثور على ملف صوت يوتيوب بعد التحميل');
  }

  return files[0];
}

function getFileSizeMb(filePath) {
  const stat = fs.statSync(filePath);
  return stat.size / 1024 / 1024;
}

async function sendLocalVideo(ctx, filePath, caption) {
  const sizeMb = getFileSizeMb(filePath);
  if (sizeMb > MAX_FILE_SIZE_MB) {
    throw new Error(`حجم الملف ${sizeMb.toFixed(2)}MB أكبر من الحد المسموح ${MAX_FILE_SIZE_MB}MB`);
  }

  await ctx.replyWithVideo(
    { source: filePath },
    { caption }
  );
}

async function sendLocalAudio(ctx, filePath, caption) {
  const sizeMb = getFileSizeMb(filePath);
  if (sizeMb > MAX_FILE_SIZE_MB) {
    throw new Error(`حجم الملف ${sizeMb.toFixed(2)}MB أكبر من الحد المسموح ${MAX_FILE_SIZE_MB}MB`);
  }

  await ctx.replyWithAudio(
    { source: filePath },
    { caption }
  );
}

bot.start(async (ctx) => {
  cleanupOldFiles();
  cleanupPendingUrls();

  await ctx.reply(
    `أهلاً بك في بوت التحميل الذكي 🚀

- أرسل رابط تيك توك أو إنستغرام للتحميل المباشر.
- أرسل رابط يوتيوب للاختيار بين (فيديو أو صوت).

بواسطة: ${BOT_RIGHTS}`
  );
});

bot.on('text', async (ctx) => {
  cleanupOldFiles();
  cleanupPendingUrls();

  const text = (ctx.message.text || '').trim();
  const url = extractUrl(text);

  if (!url) {
    await ctx.reply('❌ أرسل رابطًا صحيحًا من تيك توك أو إنستغرام أو يوتيوب.');
    return;
  }

  if (isTikTokUrl(url)) {
    const waitMsg = await ctx.reply('جاري سحب فيديو تيك توك... ⚡');

    try {
      const body = `url=${encodeURIComponent(url)}`;
      const response = await makeRequest('https://www.tikwm.com/api/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body)
        },
        body
      });

      const json = JSON.parse(response.body || '{}');

      if (json.code === 0 && json.data && json.data.play) {
        await ctx.replyWithVideo(json.data.play, {
          caption: `✅ تم تحميل الفيديو بواسطة: ${BOT_RIGHTS}`
        });
        await ctx.deleteMessage(waitMsg.message_id).catch(() => {});
      } else {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          waitMsg.message_id,
          undefined,
          '❌ الرابط به مشكلة.'
        ).catch(async () => {
          await ctx.reply('❌ الرابط به مشكلة.');
        });
      }
    } catch (error) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        waitMsg.message_id,
        undefined,
        '❌ حدث خطأ أثناء التحميل.'
      ).catch(async () => {
        await ctx.reply('❌ حدث خطأ أثناء التحميل.');
      });
    }

    return;
  }

  if (isYoutubeUrl(url)) {
    const { markup } = createYoutubeButtons(url);
    await ctx.reply('لقد أرسلت رابط يوتيوب، اختر الصيغة المطلوبة:', markup);
    return;
  }

  if (isInstagramUrl(url)) {
    const waitMsg = await ctx.reply('جاري سحب فيديو إنستغرام... ⏳');
    let filePath = null;

    try {
      filePath = await downloadInstagramVideo(url);

      await sendLocalVideo(
        ctx,
        filePath,
        `✅ تم تحميل الفيديو بواسطة: ${BOT_RIGHTS}`
      );

      await ctx.deleteMessage(waitMsg.message_id).catch(() => {});
    } catch (error) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        waitMsg.message_id,
        undefined,
        `❌ فشل التحميل. تأكد أن الحساب عام.\n${error.message}`
      ).catch(async () => {
        await ctx.reply(`❌ فشل التحميل. تأكد أن الحساب عام.\n${error.message}`);
      });
    } finally {
      removeFileSafe(filePath);
    }

    return;
  }

  await ctx.reply('❌ هذا الرابط غير مدعوم.');
});

bot.action(/^(mp3|mp4):(.+)$/, async (ctx) => {
  cleanupOldFiles();
  cleanupPendingUrls();

  await ctx.answerCbQuery('جاري التحميل... انتظر ثواني');

  const action = ctx.match[1];
  const key = ctx.match[2];
  const saved = pendingUrls.get(key);

  if (!saved || !saved.url) {
    await ctx.reply('❌ انتهت صلاحية الرابط. أرسله من جديد.');
    return;
  }

  const url = saved.url;
  const waitMsg = await ctx.reply('جاري معالجة طلبك من يوتيوب... ⏳');

  let filePath = null;

  try {
    if (action === 'mp3') {
      filePath = await downloadYoutubeAudio(url);
      await sendLocalAudio(
        ctx,
        filePath,
        `✅ تم تحميل الصوت بواسطة: ${BOT_RIGHTS}`
      );
    } else {
      filePath = await downloadYoutubeVideo(url);
      await sendLocalVideo(
        ctx,
        filePath,
        `✅ تم تحميل الفيديو بواسطة: ${BOT_RIGHTS}`
      );
    }

    await ctx.deleteMessage(waitMsg.message_id).catch(() => {});
  } catch (error) {
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      waitMsg.message_id,
      undefined,
      `❌ حدث خطأ: ${error.message}`
    ).catch(async () => {
      await ctx.reply(`❌ حدث خطأ: ${error.message}`);
    });
  } finally {
    removeFileSafe(filePath);
  }
});

bot.catch((err) => {
  console.error('Bot error:', err);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

(async () => {
  try {
    cleanupOldFiles();
    cleanupPendingUrls();
    await bot.launch();
    console.log('البوت شغال بنظام الأزرار والحقوق... جربه هسه! 🚀');
  } catch (error) {
    console.error('Startup error:', error);
    process.exit(1);
  }
})();
