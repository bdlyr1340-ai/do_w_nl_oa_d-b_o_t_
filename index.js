require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Telegraf, Markup } = require('telegraf');
const ffmpeg = require('fluent-ffmpeg');
const { Pool } = require('pg');
const { exec } = require('child_process');
const util = require('util');

const execAsync = util.promisify(exec);

const BOT_TOKEN = process.env.BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL || '';
const TMP_DIR = process.env.TMP_DIR || './tmp';
const MAX_FILE_SIZE_MB = Number(process.env.MAX_FILE_SIZE_MB || 50);
const PORT = Number(process.env.PORT || 3000);
const USE_WEBHOOK = String(process.env.USE_WEBHOOK || 'false') === 'true';
const WEBHOOK_DOMAIN = process.env.WEBHOOK_DOMAIN || '';
const WEBHOOK_PATH = process.env.WEBHOOK_PATH || '/telegram-webhook';

if (!BOT_TOKEN) {
  console.error('Missing BOT_TOKEN in environment variables');
  process.exit(1);
}

if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

const bot = new Telegraf(BOT_TOKEN);

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
    })
  : null;

async function initDb() {
  if (!pool) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      telegram_id BIGINT UNIQUE NOT NULL,
      username TEXT,
      full_name TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS jobs (
      id SERIAL PRIMARY KEY,
      telegram_id BIGINT NOT NULL,
      username TEXT,
      source_type TEXT NOT NULL,
      task_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      input_file_id TEXT,
      input_file_path TEXT,
      output_file_path TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
}

async function saveUser(user) {
  if (!pool || !user) return;

  await pool.query(
    `INSERT INTO users (telegram_id, username, full_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (telegram_id)
     DO UPDATE SET username = EXCLUDED.username, full_name = EXCLUDED.full_name`,
    [
      user.id,
      user.username || null,
      [user.first_name, user.last_name].filter(Boolean).join(' ') || null
    ]
  );
}

async function saveJob(data) {
  if (!pool) return null;

  const result = await pool.query(
    `INSERT INTO jobs (telegram_id, username, source_type, task_type, status, input_file_id, input_file_path, output_file_path)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      data.telegram_id,
      data.username || null,
      data.source_type,
      data.task_type,
      data.status || 'pending',
      data.input_file_id || null,
      data.input_file_path || null,
      data.output_file_path || null
    ]
  );

  return result.rows[0]?.id || null;
}

async function updateJob(jobId, status, outputPath = null) {
  if (!pool || !jobId) return;

  await pool.query(
    'UPDATE jobs SET status = $1, output_file_path = COALESCE($2, output_file_path) WHERE id = $3',
    [status, outputPath, jobId]
  );
}

function getMainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('تحميل الفيديو من الرابط', 'download_video')],
    [Markup.button.callback('تحويل آخر ملف إلى MP3', 'to_mp3')],
    [Markup.button.callback('إحصائيات', 'stats')]
  ]);
}

function userStateFile(userId) {
  return path.join(TMP_DIR, `${userId}.json`);
}

function setUserState(userId, data) {
  fs.writeFileSync(userStateFile(userId), JSON.stringify(data, null, 2));
}

function getUserState(userId) {
  const file = userStateFile(userId);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function clearUserState(userId) {
  const file = userStateFile(userId);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

function cleanupFile(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (err) {
    console.error('Cleanup error:', err.message);
  }
}

function isSupportedUrl(text = '') {
  const urlRegex = /(https?:\/\/[^\s]+)/i;
  if (!urlRegex.test(text)) return false;

  return /instagram\.com|instagr\.am|tiktok\.com|vm\.tiktok\.com/i.test(text);
}

function extractUrl(text = '') {
  const match = text.match(/(https?:\/\/[^\s]+)/i);
  return match ? match[1] : null;
}

function convertToMp3(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .noVideo()
      .audioCodec('libmp3lame')
      .audioBitrate('192k')
      .on('end', () => resolve(outputPath))
      .on('error', reject)
      .save(outputPath);
  });
}

async function downloadWithYtDlp(url, userId) {
  const outputTemplate = path.join(TMP_DIR, `${userId}-${Date.now()}-%(title).80s.%(ext)s`);

  const command = `yt-dlp -f "mp4/bestvideo+bestaudio/best" --merge-output-format mp4 -o "${outputTemplate}" "${url}"`;
  await execAsync(command);

  const files = fs
    .readdirSync(TMP_DIR)
    .map(name => path.join(TMP_DIR, name))
    .filter(file => file.includes(`${userId}-`))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

  if (!files.length) {
    throw new Error('لم يتم العثور على الملف بعد التحميل');
  }

  return files[0];
}

async function processUserMp3(ctx) {
  const userId = ctx.from.id;
  const state = getUserState(userId);

  if (!state?.input_path || !fs.existsSync(state.input_path)) {
    await ctx.reply('لا يوجد ملف محفوظ. أرسل رابط فيديو أولاً.');
    return;
  }

  const jobId = await saveJob({
    telegram_id: ctx.from.id,
    username: ctx.from.username,
    source_type: state.source_type || 'url_download',
    task_type: 'mp3',
    status: 'processing',
    input_file_path: state.input_path
  });

  try {
    await ctx.reply('جاري تحويل الملف إلى MP3...');

    const outputPath = path.join(TMP_DIR, `${userId}-${Date.now()}.mp3`);
    await convertToMp3(state.input_path, outputPath);

    await ctx.replyWithAudio({ source: outputPath });
    await updateJob(jobId, 'done', outputPath);

    cleanupFile(outputPath);
  } catch (error) {
    console.error(error);
    await updateJob(jobId, 'failed');
    await ctx.reply('حدث خطأ أثناء تحويل الملف إلى MP3. تأكد أن ffmpeg مثبت بشكل صحيح.');
  }
}

bot.start(async (ctx) => {
  await saveUser(ctx.from);
  await ctx.reply(
    'أهلاً بك.\n\nأرسل رابط فيديو من إنستغرام أو تيك توك، وسأقوم بتحميله لك.\nبعد التحميل يمكنك أيضًا تحويل آخر ملف إلى MP3.',
    getMainMenu()
  );
});

bot.command('help', async (ctx) => {
  await ctx.reply(
    'طريقة الاستخدام:\n1) أرسل رابط من Instagram أو TikTok\n2) سيقوم البوت بتحميل الفيديو\n3) يمكنك الضغط على "تحويل آخر ملف إلى MP3"\n\nالأوامر:\n/start\n/help\n/stats',
    getMainMenu()
  );
});

bot.command('stats', async (ctx) => {
  if (!pool) {
    await ctx.reply('قاعدة البيانات غير مفعلة. أضف DATABASE_URL.');
    return;
  }

  const users = await pool.query('SELECT COUNT(*)::int AS count FROM users');
  const jobs = await pool.query('SELECT COUNT(*)::int AS count FROM jobs');

  await ctx.reply(`عدد المستخدمين: ${users.rows[0].count}\nعدد العمليات: ${jobs.rows[0].count}`);
});

bot.action('download_video', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('أرسل الآن رابط الفيديو من Instagram أو TikTok.');
});

bot.action('to_mp3', async (ctx) => {
  await ctx.answerCbQuery();
  await processUserMp3(ctx);
});

bot.action('stats', async (ctx) => {
  await ctx.answerCbQuery();

  if (!pool) {
    await ctx.reply('قاعدة البيانات غير مفعلة. أضف DATABASE_URL.');
    return;
  }

  const users = await pool.query('SELECT COUNT(*)::int AS count FROM users');
  const jobs = await pool.query('SELECT COUNT(*)::int AS count FROM jobs');

  await ctx.reply(`عدد المستخدمين: ${users.rows[0].count}\nعدد العمليات: ${jobs.rows[0].count}`);
});

bot.on('text', async (ctx) => {
  await saveUser(ctx.from);

  const text = ctx.message.text?.trim() || '';
  if (!isSupportedUrl(text)) {
    await ctx.reply('أرسل رابطًا صحيحًا من Instagram أو TikTok.', getMainMenu());
    return;
  }

  const url = extractUrl(text);
  if (!url) {
    await ctx.reply('تعذر استخراج الرابط. أرسل الرابط بشكل صحيح.');
    return;
  }

  let downloadedFile = null;
  let jobId = null;

  try {
    await ctx.reply('جاري تحميل الفيديو من الرابط...');

    jobId = await saveJob({
      telegram_id: ctx.from.id,
      username: ctx.from.username,
      source_type: 'url',
      task_type: 'download_video',
      status: 'processing',
      input_file_path: url
    });

    downloadedFile = await downloadWithYtDlp(url, ctx.from.id);

    const stats = fs.statSync(downloadedFile);
    const sizeMb = stats.size / 1024 / 1024;

    if (sizeMb > MAX_FILE_SIZE_MB) {
      await updateJob(jobId, 'failed');
      cleanupFile(downloadedFile);
      await ctx.reply(`تم التحميل لكن حجم الملف ${sizeMb.toFixed(2)}MB وهو أكبر من الحد المسموح ${MAX_FILE_SIZE_MB}MB`);
      return;
    }

    setUserState(ctx.from.id, {
      input_path: downloadedFile,
      source_type: 'url_download',
      uploaded_at: Date.now()
    });

    await ctx.replyWithVideo({ source: downloadedFile });
    await updateJob(jobId, 'done', downloadedFile);

    await ctx.reply('تم تحميل الفيديو بنجاح. يمكنك الآن تحويل آخر ملف إلى MP3.', getMainMenu());
  } catch (error) {
    console.error('Download error:', error);

    if (jobId) await updateJob(jobId, 'failed');

    await ctx.reply(
      'حدث خطأ أثناء تحميل الفيديو.\nتأكد من:\n- أن الرابط صحيح\n- أن الفيديو عام وليس خاصًا\n- وأن yt-dlp مثبت على السيرفر'
    );
  }
});

bot.on('message', async (ctx) => {
  if (ctx.message.text) return;
  await ctx.reply('أرسل رابط فيديو من Instagram أو TikTok فقط.', getMainMenu());
});

async function start() {
  await initDb();

  if (USE_WEBHOOK && WEBHOOK_DOMAIN) {
    await bot.launch({
      webhook: {
        domain: WEBHOOK_DOMAIN,
        hookPath: WEBHOOK_PATH,
        port: PORT
      }
    });
    console.log(`Bot running with webhook: ${WEBHOOK_DOMAIN}${WEBHOOK_PATH}`);
  } else {
    await bot.launch();
    console.log('Bot running with long polling');
  }
}

start().catch((err) => {
  console.error('Startup error:', err);
  process.exit(1);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
