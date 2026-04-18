require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Telegraf, Markup } = require('telegraf');
const ffmpeg = require('fluent-ffmpeg');
const { Pool } = require('pg');

const BOT_TOKEN = process.env.BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL || '';
const ADMIN_ID = process.env.ADMIN_ID || '';
const TMP_DIR = process.env.TMP_DIR || './tmp';
const MAX_FILE_SIZE_MB = Number(process.env.MAX_FILE_SIZE_MB || 50);
const PORT = Number(process.env.PORT || 3000);
const USE_WEBHOOK = String(process.env.USE_WEBHOOK || 'false') === 'true';
const WEBHOOK_DOMAIN = process.env.WEBHOOK_DOMAIN || '';

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
    [user.id, user.username || null, [user.first_name, user.last_name].filter(Boolean).join(' ') || null]
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
    [Markup.button.callback('تحويل إلى MP3', 'to_mp3')],
    [Markup.button.callback('تحويل إلى MP4', 'to_mp4')],
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

function downloadTelegramFile(fileUrl, destination) {
  return new Promise(async (resolve, reject) => {
    try {
      const res = await fetch(fileUrl);
      if (!res.ok) throw new Error('Failed to download file from Telegram');
      const buffer = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(destination, buffer);
      resolve(destination);
    } catch (error) {
      reject(error);
    }
  });
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

function convertToMp4(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .videoCodec('libx264')
      .audioCodec('aac')
      .outputOptions(['-movflags +faststart'])
      .on('end', () => resolve(outputPath))
      .on('error', reject)
      .save(outputPath);
  });
}

async function processUserVideo(ctx, taskType) {
  const userId = ctx.from.id;
  const state = getUserState(userId);
  if (!state?.file_id) {
    await ctx.reply('أرسل فيديو أولاً ثم اختر العملية.');
    return;
  }

  const jobId = await saveJob({
    telegram_id: ctx.from.id,
    username: ctx.from.username,
    source_type: 'telegram_upload',
    task_type: taskType,
    status: 'processing',
    input_file_id: state.file_id,
    input_file_path: state.input_path
  });

  try {
    await ctx.reply('جاري المعالجة...');

    const outputPath = taskType === 'mp3'
      ? path.join(TMP_DIR, `${userId}-${Date.now()}.mp3`)
      : path.join(TMP_DIR, `${userId}-${Date.now()}.mp4`);

    if (taskType === 'mp3') {
      await convertToMp3(state.input_path, outputPath);
      await ctx.replyWithAudio({ source: outputPath });
    } else {
      await convertToMp4(state.input_path, outputPath);
      await ctx.replyWithVideo({ source: outputPath });
    }

    await updateJob(jobId, 'done', outputPath);
  } catch (error) {
    console.error(error);
    await updateJob(jobId, 'failed');
    await ctx.reply('حدث خطأ أثناء المعالجة. تأكد أن ffmpeg موجود وأن الفيديو صالح.');
  }
}

bot.start(async (ctx) => {
  await saveUser(ctx.from);
  await ctx.reply(
    'أهلاً بك. هذا بوت بسيط بملف index.js واحد تقريبًا.\n\nأرسل فيديو من جهازك ثم اختر:\n- تحويل إلى MP3\n- تحويل إلى MP4',
    getMainMenu()
  );
});

bot.command('help', async (ctx) => {
  await ctx.reply(
    'طريقة الاستخدام:\n1) أرسل فيديو\n2) اختر تحويل إلى MP3 أو MP4\n\nالأوامر:\n/start\n/help\n/stats',
    getMainMenu()
  );
});

bot.command('stats', async (ctx) => {
  if (!pool) {
    await ctx.reply('قاعدة البيانات غير مفعلة. أضف DATABASE_URL على Railway.');
    return;
  }

  const users = await pool.query('SELECT COUNT(*)::int AS count FROM users');
  const jobs = await pool.query('SELECT COUNT(*)::int AS count FROM jobs');
  await ctx.reply(`عدد المستخدمين: ${users.rows[0].count}\nعدد العمليات: ${jobs.rows[0].count}`);
});

bot.on('video', async (ctx) => {
  await saveUser(ctx.from);

  const video = ctx.message.video;
  const sizeMb = (video.file_size || 0) / 1024 / 1024;
  if (sizeMb > MAX_FILE_SIZE_MB) {
    await ctx.reply(`حجم الملف أكبر من الحد المسموح: ${MAX_FILE_SIZE_MB}MB`);
    return;
  }

  const file = await ctx.telegram.getFile(video.file_id);
  const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
  const ext = path.extname(file.file_path || '') || '.mp4';
  const localPath = path.join(TMP_DIR, `${ctx.from.id}-${Date.now()}${ext}`);

  await ctx.reply('تم استلام الفيديو، جاري تنزيله...');
  await downloadTelegramFile(fileUrl, localPath);

  setUserState(ctx.from.id, {
    file_id: video.file_id,
    input_path: localPath,
    uploaded_at: Date.now()
  });

  await ctx.reply('اختر العملية التي تريدها:', getMainMenu());
});

bot.action('to_mp3', async (ctx) => {
  await ctx.answerCbQuery();
  await processUserVideo(ctx, 'mp3');
});

bot.action('to_mp4', async (ctx) => {
  await ctx.answerCbQuery();
  await processUserVideo(ctx, 'mp4');
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

bot.on('message', async (ctx) => {
  if (ctx.message.video) return;
  await ctx.reply('أرسل فيديو من جهازك أولاً.', getMainMenu());
});

async function start() {
  await initDb();

  if (USE_WEBHOOK && WEBHOOK_DOMAIN) {
    await bot.launch({
      webhook: {
        domain: WEBHOOK_DOMAIN,
        port: PORT
      }
    });
    console.log(`Bot running with webhook on port ${PORT}`);
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
