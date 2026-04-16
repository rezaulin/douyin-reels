/**
 * Douyin → Facebook Reels (Telegram Bot)
 * Terima URL Douyin via Telegram, download & upload ke FB Reels
 */

import { DouyinDL, downloadVideo } from './douyin-api.js';
import { TikTokDL } from './tiktok-api.js';
import { InstagramDL } from './instagram-api.js';
import { uploadVideo, postPhoto } from './fb-api.js';
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

// Simpan upload lokal yang menunggu konfirmasi
const pendingLocalUploads = new Map();

// Max file size: 20MB
const MAX_FILE_SIZE = 20 * 1024 * 1024;

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
  if (url.includes('instagram.com') || url.includes('instagr.am')) return 'instagram';
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
    return bot.sendMessage(chatId, '❌ URL tidak didukung. Kirim URL Douyin, TikTok, atau Instagram.', {
      replyToMessage: msg.message_id,
    });
  }

  const platformNames = { douyin: 'Douyin', tiktok: 'TikTok', instagram: 'Instagram' };
  const platformName = platformNames[platform] || platform;

  try {
    // 1. Processing
    await bot.sendMessage(chatId, `🔍 Sedang memproses URL ${platformName}...`, {
      replyToMessage: msg.message_id,
    });

    // 2. Fetch data
    let result;
    if (platform === 'douyin') {
      result = await DouyinDL(url);
    } else if (platform === 'tiktok') {
      result = await TikTokDL(url);
    } else if (platform === 'instagram') {
      result = await InstagramDL(url);
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
    
    // Instagram: download via yt-dlp (bukan direct URL)
    if (platform === 'instagram') {
      await processInstagramDownload(bot, chatId, msg.message_id, {
        result,
        url,
        userId,
      });
      return;
    }
    
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

// ── Process Instagram Download ──────────────────────────

async function processInstagramDownload(bot, chatId, msgId, opts) {
  const { result, url, userId } = opts;

  try {
    const data = result.result || result;
    const duration = data.duration || 0;

    // Cek durasi
    if (duration > 90) {
      await bot.sendMessage(chatId,
        `⚠️ Video ${duration}s melebihi batas FB Reels (90s).\nHanya download, tidak upload ke Facebook.`,
        { replyToMessage: msgId }
      );
    }

    const namafile = `ig_${Date.now()}`;
    const downloadDir = path.resolve('./download');
    const outputPath = path.resolve(downloadDir, `${namafile}.mp4`);

    if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir, { recursive: true });

    await bot.sendMessage(chatId, '⬇️ Downloading dari Instagram via yt-dlp...', {
      replyToMessage: msgId,
    });

    // Import instagram download function
    const { downloadVideo: igDownload } = await import('./instagram-api.js');
    await igDownload(url, outputPath);

    // Cek file exists
    if (!fs.existsSync(outputPath)) {
      // Cari file yang mungkin nama berbeda
      const files = fs.readdirSync(downloadDir).filter(f => f.startsWith(namafile));
      if (files.length === 0) {
        throw new Error('File tidak ditemukan setelah download');
      }
    }

    const finalPath = fs.existsSync(outputPath) 
      ? outputPath 
      : path.join(downloadDir, fs.readdirSync(downloadDir).find(f => f.startsWith(namafile)));

    // Kirim video ke Telegram
    const caption = data.caption ? data.caption.substring(0, 1024) : '';
    await bot.sendVideo(chatId, finalPath, {
      caption: caption,
      replyToMessage: msgId,
    });

    // Upload ke Reels (jika durasi <= 90s)
    if (duration <= 90 && duration > 0) {
      await bot.sendMessage(chatId, '📤 Mengupload ke Facebook Reels...', {
        replyToMessage: msgId,
      });

      const upload = await uploadVideo(finalPath, '', caption);

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

    // Cleanup file
    try { fs.unlinkSync(finalPath); } catch {}

  } catch (err) {
    console.error('Instagram Download Error:', err.message);
    await bot.sendMessage(chatId, `💥 Error: ${err.message}`, {
      replyToMessage: msgId,
    });
  }
}

// ── Handle Local Video Upload ───────────────────────────

bot.on('video', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const video = msg.video;

  // Cek ukuran file
  const fileSize = video.file_size || 0;
  if (fileSize > MAX_FILE_SIZE) {
    return bot.sendMessage(chatId,
      `❌ Video terlalu besar: ${(fileSize / 1024 / 1024).toFixed(1)} MB\n` +
      `Maksimal: 20 MB. Compress dulu atau kirim video lebih kecil.`,
      { replyToMessage: msg.message_id }
    );
  }

  const sizeMB = (fileSize / 1024 / 1024).toFixed(1);
  const duration = video.duration || 0;
  const fileName = video.file_name || `local_${Date.now()}.mp4`;

  // Simpan data untuk konfirmasi
  const uploadId = `local_${msg.message_id}`;
  pendingLocalUploads.set(uploadId, {
    fileId: video.file_id,
    fileName,
    fileSize,
    fileType: 'video',
    duration,
    chatId,
    userId,
    msgId: msg.message_id,
  });

  // Auto-cleanup 5 menit
  setTimeout(() => pendingLocalUploads.delete(uploadId), 300000);

  // Tampilkan opsi
  const info = [
    `📹 Video diterima!`,
    `📁 File: ${fileName}`,
    `📦 Ukuran: ${sizeMB} MB`,
    duration ? `⏱️ Durasi: ${duration}s` : '',
    '',
    `Mau upload ke mana?`,
  ].filter(Boolean).join('\n');

  const keyboard = bot.inlineKeyboard([
    [bot.inlineButton('🎬 Upload ke FB Reels', { callback: `local:reels:${uploadId}` })],
    [bot.inlineButton('📄 Upload ke FB Page (Video)', { callback: `local:page:${uploadId}` })],
    [bot.inlineButton('❌ Batal', { callback: `local:cancel:${uploadId}` })],
  ]);

  return bot.sendMessage(chatId, info, {
    replyToMessage: msg.message_id,
    replyMarkup: keyboard,
  });
});

// ── Handle Local Photo Upload ───────────────────────────

bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  // Ambil foto resolusi terbesar
  const photos = msg.photo;
  const bestPhoto = photos[photos.length - 1];

  // Cek ukuran file
  const fileSize = bestPhoto.file_size || 0;
  if (fileSize > MAX_FILE_SIZE) {
    return bot.sendMessage(chatId,
      `❌ Foto terlalu besar: ${(fileSize / 1024 / 1024).toFixed(1)} MB\n` +
      `Maksimal: 20 MB.`,
      { replyToMessage: msg.message_id }
    );
  }

  const sizeMB = (fileSize / 1024 / 1024).toFixed(1);
  const caption = msg.caption || '';

  // Simpan data
  const uploadId = `local_${msg.message_id}`;
  pendingLocalUploads.set(uploadId, {
    fileId: bestPhoto.file_id,
    fileName: `photo_${Date.now()}.jpg`,
    fileSize,
    fileType: 'photo',
    caption,
    chatId,
    userId,
    msgId: msg.message_id,
  });

  setTimeout(() => pendingLocalUploads.delete(uploadId), 300000);

  const info = [
    `📸 Foto diterima!`,
    `📦 Ukuran: ${sizeMB} MB`,
    caption ? `📝 Caption: ${caption.substring(0, 80)}` : '',
    '',
    `Mau upload ke mana?`,
  ].filter(Boolean).join('\n');

  const keyboard = bot.inlineKeyboard([
    [bot.inlineButton('📸 Upload ke FB Page (Photo)', { callback: `local:photo:${uploadId}` })],
    [bot.inlineButton('❌ Batal', { callback: `local:cancel:${uploadId}` })],
  ]);

  return bot.sendMessage(chatId, info, {
    replyToMessage: msg.message_id,
    replyMarkup: keyboard,
  });
});

// ── Callback: Local Upload Options ──────────────────────

bot.on('callbackQuery', async (msg) => {
  const data = msg.data;

  // Handle local upload callbacks
  if (data && data.startsWith('local:')) {
    const parts = data.split(':');
    const action = parts[1]; // reels, page, photo, cancel
    const uploadId = parts.slice(2).join(':');

    const pending = pendingLocalUploads.get(uploadId);
    if (!pending) {
      return bot.answerCallbackQuery(msg.id, {
        text: '⏰ Session expired. Kirim file lagi.',
        showAlert: true,
      });
    }

    if (action === 'cancel') {
      pendingLocalUploads.delete(uploadId);
      await bot.answerCallbackQuery(msg.id, { text: '❌ Dibatalkan' });
      try {
        await bot.editMessageReplyMarkup({
          chatId: pending.chatId,
          messageId: msg.message.message_id,
        }, bot.inlineKeyboard([]));
      } catch {}
      return;
    }

    await bot.answerCallbackQuery(msg.id, { text: '⏳ Memproses...' });

    // Hapus keyboard
    try {
      await bot.editMessageReplyMarkup({
        chatId: pending.chatId,
        messageId: msg.message.message_id,
      }, bot.inlineKeyboard([]));
    } catch {}

    pendingLocalUploads.delete(uploadId);

    // Download file dari Telegram
    try {
      const fileLink = await bot.getFileLink(pending.fileId);
      const downloadDir = path.resolve('./download');
      if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir, { recursive: true });

      const localPath = path.resolve(downloadDir, pending.fileName);

      await bot.sendMessage(pending.chatId, `⬇️ Mengunduh file dari Telegram...`, {
        replyToMessage: pending.msgId,
      });

      const response = await axios({
        url: fileLink,
        method: 'GET',
        responseType: 'stream',
        timeout: 60000,
      });

      const writer = fs.createWriteStream(localPath);
      response.data.pipe(writer);
      await new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
      });

      await bot.sendMessage(pending.chatId, `✅ File terunduh!`, {
        replyToMessage: pending.msgId,
      });

      if (action === 'reels') {
        // Upload ke FB Reels
        await bot.sendMessage(pending.chatId, '📤 Mengupload ke Facebook Reels...', {
          replyToMessage: pending.msgId,
        });

        const caption = pending.caption || '';
        const upload = await uploadVideo(localPath, '', caption);

        if (upload.status === 'success') {
          await bot.sendMessage(pending.chatId, `🎉 ${upload.message}`, {
            replyToMessage: pending.msgId,
          });
        } else {
          await bot.sendMessage(pending.chatId, `⚠️ Upload gagal: ${upload.message}`, {
            replyToMessage: pending.msgId,
          });
        }
      } else if (action === 'page') {
        // Upload video ke FB Page (bukan Reels)
        await bot.sendMessage(pending.chatId, '📤 Mengupload video ke Facebook Page...', {
          replyToMessage: pending.msgId,
        });

        const caption = pending.caption || '';
        const upload = await uploadVideo(localPath, pending.fileName, caption);

        if (upload.status === 'success') {
          await bot.sendMessage(pending.chatId, `🎉 ${upload.message}`, {
            replyToMessage: pending.msgId,
          });
        } else {
          await bot.sendMessage(pending.chatId, `⚠️ Upload gagal: ${upload.message}`, {
            replyToMessage: pending.msgId,
          });
        }
      } else if (action === 'photo') {
        // Upload foto ke FB Page
        await bot.sendMessage(pending.chatId, '📤 Mengupload foto ke Facebook Page...', {
          replyToMessage: pending.msgId,
        });

        // Convert local file to URL or use Graph API photo upload
        const form = new (await import('form-data')).default();
        form.append('source', fs.createReadStream(localPath));
        form.append('message', pending.caption || '');

        const config = JSON.parse(fs.readFileSync(path.resolve('./config.json'), 'utf-8'));
        form.append('access_token', config.pageAccessToken);

        const res = await axios.post(
          `https://graph.facebook.com/v21.0/${config.pageId}/photos`,
          form,
          { headers: form.getHeaders(), timeout: 60000 }
        );

        if (res.data?.id) {
          await bot.sendMessage(pending.chatId,
            `🎉 Foto berhasil diupload! ID: ${res.data.id}\n` +
            `🔗 https://www.facebook.com/${config.pageId}/photos/${res.data.id}`,
            { replyToMessage: pending.msgId }
          );
        } else {
          await bot.sendMessage(pending.chatId, '⚠️ Upload foto gagal.', {
            replyToMessage: pending.msgId,
          });
        }
      }

      if (pending.userId) updateUserStats(pending.userId);

      // Cleanup
      try { fs.unlinkSync(localPath); } catch {}

    } catch (err) {
      console.error('Local Upload Error:', err.message);
      await bot.sendMessage(pending.chatId, `💥 Error: ${err.message}`, {
        replyToMessage: pending.msgId,
      });
    }

    return;
  }

  // Handle quality selection callbacks (existing code)
  if (!data || !data.startsWith('quality:')) return;

  const parts = data.split(':');
  const formatIndex = parseInt(parts.pop());
  const videoId = parts.slice(1).join(':');

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

  pendingDownloads.delete(videoId);

  await bot.answerCallbackQuery(msg.id, {
    text: `✅ Dipilih: ${format.format}`,
  });

  try {
    await bot.editMessageReplyMarkup({
      chatId: pending.chatId,
      messageId: msg.message.message_id,
    }, bot.inlineKeyboard([]));
  } catch {}

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
    'Kirim URL atau file langsung:\n\n' +
    '📱 URL Mode:\n' +
    '• Kirim URL Douyin/TikTok/Instagram\n' +
    '• Bot download → kirim video → upload ke FB\n\n' +
    '📁 Local Mode (BARU!):\n' +
    '• Kirim video (max 20MB) → pilih: FB Reels / FB Page\n' +
    '• Kirim foto (max 20MB) → upload ke FB Page\n\n' +
    `Batas: ${MAX_DOWNLOADS_PER_DAY} download/hari\n\n` +
    'URL yang didukung:\n' +
    'Douyin:\n' +
    '• https://v.douyin.com/xxxxx/\n' +
    '• https://www.douyin.com/video/xxxxx\n\n' +
    'TikTok:\n' +
    '• https://www.tiktok.com/@user/video/xxx\n' +
    '• https://vm.tiktok.com/xxxxx/\n\n' +
    'Instagram:\n' +
    '• https://www.instagram.com/reel/xxxxx/',
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
