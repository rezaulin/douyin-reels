/**
 * Douyin & TikTok → Facebook Reels
 * Download video dari Douyin/TikTok, upload otomatis ke Facebook Page Reels
 * 
 * Usage: 
 *   node index.js                    # Mode interaktif
 *   node index.js --batch urls.txt   # Batch mode
 *   node index.js --tiktok           # TikTok only
 *   node index.js --douyin           # Douyin only
 *   node index.js --instagram         # Instagram only
 */

import { DouyinDL } from './douyin-api.js';
import { TikTokDL } from './tiktok-api.js';
import { InstagramDL, downloadVideo as igDownload } from './instagram-api.js';
import { uploadVideo, getPageInfo } from './fb-api.js';
import { translate, translateCaption } from './translate.js';
import axios from 'axios';
import ProgressBar from 'progress';
import chalk from 'chalk';
import path from 'path';
import fs from 'fs';
import readlineSync from 'readline-sync';
import Queue from 'better-queue';

// ── Config ──────────────────────────────────────────────
const CONFIG = {
  downloadDir: './download',
  maxVideoDuration: 90,  // FB Reels max 90 detik
  skipExisting: true,
};

// ── Utility Functions ───────────────────────────────────

function detectPlatform(url) {
  if (!url) return null;
  url = url.trim().toLowerCase();
  if (url.includes('douyin.com') || url.includes('v.douyin.com')) return 'douyin';
  if (url.includes('tiktok.com') || url.includes('vt.tiktok.com') || url.includes('vm.tiktok.com')) return 'tiktok';
  if (url.includes('instagram.com') || url.includes('instagr.am')) return 'instagram';
  return null;
}

function chooseVideoQuality(videos) {
  if (!videos || videos.length === 0) {
    console.log(chalk.yellow('Tidak ada pilihan kualitas. Menggunakan default.'));
    return videos?.[0] || null;
  }

  const validVideos = videos.filter(v => v && typeof v === 'string' && v.startsWith('http'));
  if (validVideos.length === 0) {
    console.log(chalk.red('Tidak ada URL video yang valid.'));
    return null;
  }

  if (validVideos.length === 1) {
    return { url: validVideos[0], quality: 'default' };
  }

  console.log(chalk.cyan('\nPilih kualitas video:'));
  validVideos.forEach((url, i) => {
    let quality = 'unknown';
    if (url.includes('720p') || url.includes('play_720')) quality = '720p';
    else if (url.includes('540p') || url.includes('play_540')) quality = '540p';
    else if (url.includes('480p') || url.includes('play_480')) quality = '480p';
    else if (url.includes('360p') || url.includes('play_360')) quality = '360p';
    else if (url.includes('1080p') || url.includes('play_1080')) quality = '1080p';
    else quality = `Option ${i + 1}`;
    console.log(`  ${i + 1}. ${quality}`);
  });

  const choice = readlineSync.questionInt('Pilih nomor: ', {
    min: 1,
    max: validVideos.length,
  });

  return { url: validVideos[choice - 1], quality: 'selected' };
}

function buildCaption(result) {
  const parts = [];
  if (result.description) parts.push(result.description);
  if (result.hashtags?.length) {
    parts.push('');
    parts.push(result.hashtags.map(h => `#${h}`).join(' '));
  }
  if (result.author?.nickname) {
    parts.push('');
    parts.push(`via @${result.author.nickname || result.author.unique_id}`);
  }
  return parts.join('\n').substring(0, 2200);
}

/**
 * Compress video menggunakan ffmpeg
 */
async function compressVideo(inputPath, outputPath) {
  const { execSync } = await import('child_process');
  
  try {
    const cmd = `ffmpeg -i "${inputPath}" -c:v libx264 -crf 28 -preset fast -vf "scale=720:-2" -c:a aac -b:a 128k -y "${outputPath}" 2>&1`;
    execSync(cmd, { timeout: 300000, stdio: 'pipe' });
    return true;
  } catch (err) {
    console.error(chalk.red(`   Compress gagal: ${err.message}`));
    return false;
  }
}

async function downloadVideo(url, outputPath) {
  try {
    const { data, headers } = await axios({
      url,
      method: 'GET',
      responseType: 'stream',
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
        'Referer': 'https://www.douyin.com/',
      },
      timeout: 60000,
    });

    const totalLength = parseInt(headers['content-length']) || 0;

    if (totalLength > 0) {
      const progressBar = new ProgressBar(
        `[ ${chalk.yellow('Downloading')} ] [${chalk.green(':bar')}] :percent dalam :elapseds`,
        {
          width: 40,
          complete: '█',
          incomplete: '░',
          renderThrottle: 100,
          total: totalLength,
        }
      );
      data.on('data', (chunk) => progressBar.tick(chunk.length));
    } else {
      console.log(chalk.yellow('Downloading... (ukuran tidak diketahui)'));
    }

    const writer = fs.createWriteStream(outputPath);
    data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
  } catch (err) {
    throw new Error(`Download gagal: ${err.message}`);
  }
}

// ── Main Function ───────────────────────────────────────

async function downloadAndUpload(url) {
  try {
    const platform = detectPlatform(url);

    if (!platform) {
      console.log(chalk.red('❌ URL tidak valid. Gunakan URL dari Douyin, TikTok, atau Instagram.'));
      return;
    }

    const platformNames = { douyin: 'Douyin', tiktok: 'TikTok', instagram: 'Instagram' };
    console.log(chalk.blue(`\n🔍 Mengambil data dari ${platformNames[platform]}...`));

    // Instagram: download langsung via yt-dlp
    if (platform === 'instagram') {
      const namafile = `ig_${Date.now()}`;
      const downloadPath = path.resolve(CONFIG.downloadDir, `${namafile}.mp4`);

      if (!fs.existsSync(CONFIG.downloadDir)) {
        fs.mkdirSync(CONFIG.downloadDir, { recursive: true });
      }

      console.log(chalk.blue(`⬇️  Downloading dari Instagram via yt-dlp...`));
      await igDownload(url, downloadPath);
      console.log(chalk.green(`✅ Download selesai: ${downloadPath}`));

      // Upload ke FB Reels
      console.log(chalk.blue('\n📤 Mengupload ke Facebook Reels...'));
      const upload = await uploadVideo(downloadPath, '', '');
      if (upload.status === 'success') {
        console.log(chalk.green(`🎉 ${upload.message}`));
      } else {
        console.log(chalk.yellow(`⚠️  Upload gagal: ${upload.message}`));
      }
      return;
    }

    let result;
    if (platform === 'douyin') {
      result = await DouyinDL(url);
    } else {
      result = await TikTokDL(url);
    }

    if (result.status === 'error') {
      console.log(chalk.red(`❌ ${result.message}`));
      return;
    }

    const data = result.result;
    console.log(chalk.green(`✅ Video ditemukan: ${data.id || 'unknown'}`));
    console.log(`   Durasi: ${data.duration || '?'}s`);
    console.log(`   Author: ${data.author?.nickname || data.author?.unique_id || '-'}`);
    console.log(`   Caption: ${(data.description || '-').substring(0, 80)}...`);

    // 2. Cek tipe
    if (data.type === 'image') {
      console.log(chalk.yellow('\n📸 Ini adalah postingan foto/slide, bukan video.'));
      if (data.images?.length) {
        console.log('URL gambar:');
        data.images.forEach((img, i) => console.log(`  ${i + 1}. ${img}`));
      }
      return;
    }

    // 3. Cek durasi
    if (data.duration > CONFIG.maxVideoDuration) {
      console.log(chalk.red(`\n⚠️  Video terlalu panjang (${data.duration}s > ${CONFIG.maxVideoDuration}s)`));
      console.log(chalk.yellow('Facebook Reels maksimal 90 detik.'));
      if (!readlineSync.keyInYN('Tetap download? ')) return;
    }

    // 4. Pilih kualitas
    const video = chooseVideoQuality(data.video);
    if (!video?.url) {
      console.log(chalk.red('❌ Tidak ada URL video yang valid'));
      return;
    }

    // 5. Download
    const namafile = data.id || `${platform}_${Date.now()}`;
    const downloadPath = path.resolve(CONFIG.downloadDir, `${namafile}.mp4`);

    if (!fs.existsSync(CONFIG.downloadDir)) {
      fs.mkdirSync(CONFIG.downloadDir, { recursive: true });
    }

    if (CONFIG.skipExisting && fs.existsSync(downloadPath)) {
      console.log(chalk.yellow(`\n⏭️  File sudah ada: ${namafile}.mp4`));
    } else {
      console.log(chalk.blue(`\n⬇️  Downloading ${namafile}.mp4...`));
      await downloadVideo(video.url, downloadPath);
      console.log(chalk.green(`✅ Download selesai: ${downloadPath}`));
    }

    // 6. Build caption
    const rawCaption = buildCaption(data);
    const title = (data.description || '').substring(0, 200);

    // 6b. Auto-translate caption
    console.log(chalk.blue('\n🌐 Menerjemahkan caption...'));
    const caption = await translateCaption(rawCaption, 'en');
    console.log(chalk.green(`   Caption (EN): ${caption.substring(0, 100)}...`));

    // 7. Compress jika terlalu besar (>50MB)
    let uploadPath = downloadPath;
    const fileSize = fs.statSync(downloadPath).size;
    const maxSize = 50 * 1024 * 1024; // 50 MB

    if (fileSize > maxSize) {
      console.log(chalk.yellow(`\n📦 Video ${(fileSize / 1024 / 1024).toFixed(0)} MB terlalu besar, mengompres...`));
      const compressedPath = downloadPath.replace('.mp4', '_compressed.mp4');
      await compressVideo(downloadPath, compressedPath);
      if (fs.existsSync(compressedPath)) {
        uploadPath = compressedPath;
        const newSize = fs.statSync(compressedPath).size;
        console.log(chalk.green(`   Compressed: ${(newSize / 1024 / 1024).toFixed(1)} MB`));
      }
    }

    // 8. Upload ke Facebook Page via Graph API
    console.log(chalk.blue('\n📤 Mengupload ke Facebook Page...'));
    const upload = await uploadVideo(uploadPath, title, caption);

    if (upload.status === 'success') {
      console.log(chalk.green(`\n🎉 ${upload.message}`));
      if (upload.data?.url) {
        console.log(chalk.cyan(`🔗 ${upload.data.url}`));
      }
    } else {
      console.log(chalk.red(`\n❌ ${upload.message}`));
    }

  } catch (err) {
    console.error(chalk.red(`\n💥 Error: ${err.message}`));
  }
}

// ── Batch Mode ──────────────────────────────────────────

async function batchProcess(urls) {
  const queue = new Queue(async function (url, cb) {
    await downloadAndUpload(url);
    cb(null);
  }, { concurrent: 1 });

  for (const url of urls) {
    queue.push(url);
  }

  return new Promise((resolve) => {
    queue.on('drain', resolve);
  });
}

// ── CLI Entry Point ─────────────────────────────────────

async function main() {
  console.log(chalk.cyan.bold('\n🎵 Douyin & TikTok → Facebook Reels'));
  console.log(chalk.gray('   Download dari Douyin/TikTok, upload ke FB Page Reels\n'));

  // Cek Facebook Page Access Token
  try {
    const config = JSON.parse(fs.readFileSync('./config.json', 'utf-8'));
    if (!config.pageAccessToken) {
      console.log(chalk.red('❌ pageAccessToken tidak ada di config.json!'));
      console.log(chalk.yellow('   Cara dapatkan Page Access Token:'));
      console.log(chalk.yellow('   1. Buka https://developers.facebook.com/tools/explorer/'));
      console.log(chalk.yellow('   2. Pilih App → tambah permission: pages_read_engagement, pages_manage_posts'));
      console.log(chalk.yellow('   3. Generate Token → Copy'));
      console.log(chalk.yellow('   4. Paste ke config.json → pageAccessToken\n'));
      process.exit(1);
    }
    
    // Cek koneksi ke Page
    const pageInfo = await getPageInfo();
    if (pageInfo.status === 'success') {
      console.log(chalk.green(`✅ Terhubung ke Page: ${pageInfo.data.name} (${pageInfo.data.fan_count || 0} followers)`));
    } else {
      console.log(chalk.red(`❌ Gagal konek ke Page: ${pageInfo.message}`));
      process.exit(1);
    }
  } catch {
    console.log(chalk.red('❌ config.json tidak ditemukan!'));
    process.exit(1);
  }

  // Batch mode
  if (process.argv.includes('--batch')) {
    const urlsFile = process.argv[process.argv.indexOf('--batch') + 1];
    if (!urlsFile || !fs.existsSync(urlsFile)) {
      console.log(chalk.red(`File tidak ditemukan: ${urlsFile || '(tidak ada)'}`));
      process.exit(1);
    }
    const urls = fs.readFileSync(urlsFile, 'utf-8')
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'));

    console.log(chalk.blue(`📋 Batch mode: ${urls.length} URL\n`));
    await batchProcess(urls);
    return;
  }

  // Platform filter hints
  if (process.argv.includes('--tiktok')) {
    console.log(chalk.magenta('   Mode: TikTok only\n'));
  } else if (process.argv.includes('--douyin')) {
    console.log(chalk.red('   Mode: Douyin only\n'));
  }

  // Mode interaktif
  while (true) {
    console.log(chalk.gray('\n' + '─'.repeat(50)));
    const url = readlineSync.question(
      chalk.cyan('🔗 Masukkan URL Douyin/TikTok (atau "q" untuk keluar): ')
    );

    if (url.toLowerCase() === 'q') {
      console.log(chalk.green('\n👋 Sampai jumpa!'));
      break;
    }

    const platform = detectPlatform(url);
    if (!platform) {
      console.log(chalk.red('❌ URL tidak valid. Gunakan URL dari:'));
      console.log(chalk.gray('   Douyin: https://v.douyin.com/xxx/ atau https://douyin.com/video/xxx'));
      console.log(chalk.gray('   TikTok: https://www.tiktok.com/@user/video/xxx atau https://vm.tiktok.com/xxx'));
      continue;
    }

    // Platform filter
    if (process.argv.includes('--tiktok') && platform !== 'tiktok') {
      console.log(chalk.yellow('⚠️  Mode TikTok only, URL Douyin diabaikan'));
      continue;
    }
    if (process.argv.includes('--douyin') && platform !== 'douyin') {
      console.log(chalk.yellow('⚠️  Mode Douyin only, URL TikTok diabaikan'));
      continue;
    }

    await downloadAndUpload(url);
  }
}

main().catch(console.error);
