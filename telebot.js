/**
 * Douyin → Facebook Reels (Telegram Bot)
 * Terima URL Douyin via Telegram, download & upload ke FB Reels
 */

import { DouyinDL, downloadVideo } from './douyin-api.js';
import { TikTokDL } from './tiktok-api.js';
import { uploadVideo } from './fb-api.js';
import { translateCaption } from './translate.js';
import TeleBot from 'telebot';
import axios from 'axios';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();

const bot = new TeleBot({
  token: process.env.BOT_TOKEN,
  usePlugins: ['commandButton'],
});

// Rate limiting
const userStats = new Map();
const MAX_DOWNLOADS_PER_DAY = 10;

// Simpan data video sementara untuk pilihan kualitas
const pendingDownloads = new Map();

function updateUserStats(userId) {
  const today = new Date().toDateString();
  if (!userStats.has(userId)) {
    userStats.set(userId, { date: today, count: 1 });
  } else {
    const stats = userStats.get(userId);
    if (stats.date !== today) {
      stats.date = today;
      stats.count = 1;
    } else {
      stats.count++;
    }
  }
}

function canUserDownload(userId) {
  const stats = userStats.get(userId);
  return !stats || stats.count < MAX_DOWNLOADS_PER_DAY;
}

// ── Detect Platform ─────────────────────────────────────

function detectPlatform(url) {
  if (!url) return null;
  url = url.trim().toLowerCase();
  if (url.includes('douyin.com') || url.includes('v.douyin.com')) return 'douyin';
  if (url.includes('tiktok.com') || url.includes('vt.tiktok.com') || url.includes('vm.tiktok.com')) return 'tiktok';
  return null;
}

// ── Handle Video URL ────────────────────────────────────

async function handleVideoUrl(msg, url) {
  const userId = msg.from.id;
  const chatId = msg.chat.id;

  // Cek rate limit
  if (!canUserDownload(userId)) {
    return bot.sendMessage(chatId,
      `⚠️ Kamu sudah mencapai batas ${MAX_DOWNLOADS_PER_DAY} download/hari.`,
      { replyToMessage: msg.message_id }
    );
  }

  const platform = detectPlatform(url);
  if (!platform) {
    return bot.sendMessage(chatId, '❌ URL tidak didukung. Kirim URL Douyin atau TikTok.', {
      replyToMessage: msg.message_id,
    });
  }

  const platformName = platform === 'douyin' ? 'Douyin' : 'TikTok';

  try {
    // 1. Processing
    await bot.sendMessage(chatId, `🔍 Sedang memproses URL ${platformName}...`, {
      replyToMessage: msg.message_id,
    });

    // 2. Fetch data
    let result;
    if (platform === 'douyin') {
      result = await DouyinDL(url);
    } else {
      result = await TikTokDL(url);
    }

    if (result.status === 'error') {
      return bot.sendMessage(chatId, `❌ ${result.message}`, {
        replyToMessage: msg.message_id,
      });
    }

    const data = result.result;

    // Cek apakah image post
    if (data.type === 'image') {
      return bot.sendMessage(chatId,
        `📸 Ini adalah postingan foto (bukan video).\n` +
        `${data.images?.length || 0} foto ditemukan.`,
        { replyToMessage: msg.message_id }
      );
    }

    // 3. Info video
    const info = [
      `✅ Video ditemukan!`,
      `🆔 ID: ${data.id}`,
      `👤 Author: ${data.author?.nickname || data.author?.unique_id || '-'}`,
      `⏱️ Durasi: ${data.duration}s`,
      `📝 Caption: ${(data.description || '-').substring(0, 100)}`,
    ].join('\n');

    // 4. Tampilkan pilihan kualitas
    const formats = data.availableFormats || [];

    if (formats.length > 1) {
      // Ada multiple kualitas → tampilkan pilihan
      let qualityInfo = info + '\n\n📺 Pilih kualitas video:';

      const buttons = formats.map((f, i) => {
        const sizeMB = f.fileSize ? (f.fileSize / 1024 / 1024).toFixed(1) : '?';
        return bot.inlineButton(`${f.format} (${sizeMB}MB)`, { callback: `quality:${data.id}:${i}` });
      });

      // Arrange buttons in rows of 2
      const keyboard = bot.inlineKeyboard(
        buttons.reduce((rows, btn, i) => {
          if (i % 2 === 0) rows.push([btn]);
          else rows[rows.length - 1].push(btn);
          return rows;
        }, [])
      );

      // Simpan data untuk callback
      pendingDownloads.set(data.id, {
        data,
        url,
        platform,
        userId,
        chatId,
        msgId: msg.message_id,
        formats,
      });

      // Auto-cleanup setelah 5 menit
      setTimeout(() => pendingDownloads.delete(data.id), 300000);

      return bot.sendMessage(chatId, qualityInfo, {
        replyToMessage: msg.message_id,
        replyMarkup: keyboard,
      });
    }

    // Hanya 1 kualitas → langsung download
    await bot.sendMessage(chatId, info, { replyToMessage: msg.message_id });
    await processDownload(bot, chatId, msg.message_id, {
      data,
      url,
      platform,
      userId,
      selectedUrl: data.video?.[0],
      selectedFormat: formats[0]?.format || 'Default',
    });

  } catch (err) {
    console.error('Error:', err.message);
    await bot.sendMessage(chatId, `💥 Error: ${err.message}`, {
      replyToMessage: msg.message_id,
    });
  }
}

// ── Process Download (setelah user pilih kualitas) ────

async function processDownload(bot, chatId, msgId, opts) {
  const { data, selectedUrl, selectedFormat, userId } = opts;

  try {
    // Cek durasi
    if (data.duration > 90) {
      await bot.sendMessage(chatId,
        `⚠️ Video ${data.duration}s melebihi batas FB Reels (90s).\nHanya download, tidak upload ke Facebook.`,
        { replyToMessage: msgId }
      );
    }

    if (!selectedUrl) {
      return bot.sendMessage(chatId, '❌ Tidak ada URL video.', {
        replyToMessage: msgId,
      });
    }

    const namafile = data.id;
    const downloadDir = path.resolve('./download');
    const outputPath = path.resolve(downloadDir, `${namafile}.mp4`);

    if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir, { recursive: true });

    await bot.sendMessage(chatId, `⬇️ Downloading ${selectedFormat}...`, {
      replyToMessage: msgId,
    });

    await downloadVideo(selectedUrl, outputPath);

    // Translate caption (China → English)
    const originalCaption = [
      data.description || '',
      data.hashtags?.length ? data.hashtags.map(h => `#${h}`).join(' ') : '',
    ].filter(Boolean).join(' ');

    let translatedCaption = originalCaption;
    if (originalCaption) {
      await bot.sendMessage(chatId, '🌐 Translating caption...', {
        replyToMessage: msgId,
      });
      translatedCaption = await translateCaption(originalCaption, 'en');
    }

    // Kirim video ke Telegram (dengan caption translate)
    await bot.sendVideo(chatId, outputPath, {
      caption: [
        translatedCaption,
        data.author?.nickname ? `\nvia @${data.author.nickname}` : '',
      ].filter(Boolean).join('\n').substring(0, 1024),
      replyToMessage: msgId,
    });

    // Upload ke Reels (jika durasi <= 90s)
    if (data.duration <= 90) {
      await bot.sendMessage(chatId, '📤 Mengupload ke Facebook Reels...', {
        replyToMessage: msgId,
      });

      const upload = await uploadVideo(outputPath, '', translatedCaption);

      if (upload.status === 'success') {
        await bot.sendMessage(chatId, `🎉 ${upload.message}`, {
          replyToMessage: msgId,
        });
      } else {
        await bot.sendMessage(chatId, `⚠️ Upload Reels gagal: ${upload.message}`, {
          replyToMessage: msgId,
        });
      }
    }

    if (userId) updateUserStats(userId);

  } catch (err) {
    console.error('Download Error:', err.message);
    await bot.sendMessage(chatId, `💥 Error: ${err.message}`, {
      replyToMessage: msgId,
    });
  }
}

// ── Callback: Pilihan Kualitas ─────────────────────────

bot.on('callbackQuery', async (msg) => {
  const data = msg.data; // format: quality:VIDEOID:INDEX
  if (!data || !data.startsWith('quality:')) return;

  const parts = data.split(':');
  const formatIndex = parseInt(parts.pop()); // last part is index
  const videoId = parts.slice(1).join(':'); // middle part is video ID

  const pending = pendingDownloads.get(videoId);
  if (!pending) {
    return bot.answerCallbackQuery(msg.id, {
      text: '⏰ Session expired. Kirim URL lagi.',
      showAlert: true,
    });
  }

  const format = pending.formats[formatIndex];
  if (!format) {
    return bot.answerCallbackQuery(msg.id, {
      text: '❌ Kualitas tidak ditemukan.',
      showAlert: true,
    });
  }

  // Hapus dari pending
  pendingDownloads.delete(videoId);

  // Konfirmasi pilihan
  await bot.answerCallbackQuery(msg.id, {
    text: `✅ Dipilih: ${format.format}`,
  });

  // Edit pesan untuk hapus button
  try {
    await bot.editMessageReplyMarkup({
      chatId: pending.chatId,
      messageId: msg.message.message_id,
    }, bot.inlineKeyboard([]));
  } catch {}

  // Proses download
  await processDownload(bot, pending.chatId, pending.msgId, {
    data: pending.data,
    url: pending.url,
    platform: pending.platform,
    userId: pending.userId,
    selectedUrl: format.url,
    selectedFormat: format.format,
  });
});

// ── Bot Commands ────────────────────────────────────────

bot.on('text', async (msg) => {
  const text = msg.text;

  // Skip commands
  if (text.startsWith('/')) return;

  // Deteksi URL Douyin atau TikTok
  const platform = detectPlatform(text);
  if (platform) {
    await handleVideoUrl(msg, text.trim());
  }
});

bot.on('/start', (msg) => {
  return bot.sendMessage(msg.chat.id,
    '🎵 Douyin & TikTok → Facebook Reels Bot\n\n' +
    'Kirim URL Douyin atau TikTok dan saya akan:\n' +
    '1. Download video tanpa watermark\n' +
    '2. Kirim video ke chat\n' +
    '3. Upload otomatis ke Facebook Page Reels\n\n' +
    `Batas: ${MAX_DOWNLOADS_PER_DAY} download/hari\n\n` +
    'URL yang didukung:\n' +
    'Douyin:\n' +
    '• https://v.douyin.com/xxxxx/\n' +
    '• https://www.douyin.com/video/xxxxx\n\n' +
    'TikTok:\n' +
    '• https://www.tiktok.com/@user/video/xxx\n' +
    '• https://vm.tiktok.com/xxxxx/',
    { replyToMessage: msg.message_id }
  );
});

bot.on('/stats', (msg) => {
  const stats = userStats.get(msg.from.id);
  const count = stats?.count || 0;
  return bot.sendMessage(msg.chat.id,
    `📊 Stats hari ini: ${count}/${MAX_DOWNLOADS_PER_DAY} download`,
    { replyToMessage: msg.message_id }
  );
});

bot.on('/help', (msg) => {
  return bot.sendMessage(msg.chat.id,
    '📖 Cara pakai:\n\n' +
    '1. Buka video di Douyin\n' +
    '2. Klik Share → Copy Link\n' +
    '3. Paste link ke chat ini\n' +
    '4. Tunggu proses selesai\n\n' +
    'Commands:\n' +
    '/start - Info bot\n' +
    '/stats - Cek penggunaan hari ini\n' +
    '/help - Bantuan',
    { replyToMessage: msg.message_id }
  );
});

// ── Start Bot ───────────────────────────────────────────

console.log('🤖 Douyin → Reels Telegram Bot started!');
bot.start();
