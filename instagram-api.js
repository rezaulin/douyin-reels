/**
 * Instagram Video Downloader API
 * Method 1: Snapinsta (tanpa cookies, public content)
 * Method 2: yt-dlp fallback (butuh cookies)
 * 
 * Support URL:
 *   - https://www.instagram.com/reel/xxxxx/
 *   - https://www.instagram.com/p/xxxxx/
 *   - https://www.instagram.com/tv/xxxxx/
 *   - https://www.instagram.com/stories/xxxxx/
 */

import puppeteer from 'puppeteer';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import axios from 'axios';

const COOKIES_PATH = path.join(process.cwd(), 'cookies.txt');
const SNAPINSTA_URL = 'https://snapinsta.app/id';

const browserOpts = {
  headless: 'new',
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-extensions',
    '--disable-software-rasterizer',
    '--headless=new',
  ],
};

/**
 * Detect Instagram URL type
 */
function getMediaType(url) {
  if (url.includes('/reel/')) return 'reel';
  if (url.includes('/tv/')) return 'igtv';
  if (url.includes('/stories/')) return 'story';
  if (url.includes('/p/')) return 'post';
  return 'unknown';
}

/**
 * Check if cookies file exists
 */
function hasCookies() {
  return fs.existsSync(COOKIES_PATH);
}

/**
 * Download via Snapinsta (tanpa cookies, public content only)
 * Mirip pattern TikTok/Douyin yang pakai Seekin.ai
 */
async function fetchViaSnapinsta(url) {
  let browser;

  try {
    browser = await puppeteer.launch(browserOpts);
    const page = await browser.newPage();

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );
    await page.setViewport({ width: 1280, height: 800 });

    // Intercept download links
    let downloadLinks = [];
    page.on('response', async (response) => {
      const respUrl = response.url();
      if (respUrl.includes('.mp4') || respUrl.includes('video') || respUrl.includes('cdninstagram')) {
        downloadLinks.push(respUrl);
      }
    });

    console.log('[Instagram] Membuka Snapinsta...');
    await page.goto(SNAPINSTA_URL, { waitUntil: 'networkidle2', timeout: 30000 });

    // Tunggu input field
    await page.waitForSelector('input[name="url"], input[type="text"], textarea', { timeout: 10000 });

    const inputEl = await page.$('input[name="url"]') || await page.$('input[type="text"]') || await page.$('textarea');
    if (!inputEl) {
      throw new Error('Input field tidak ditemukan di Snapinsta');
    }

    await inputEl.click({ clickCount: 3 });
    await inputEl.type(url, { delay: 10 });
    console.log(`[Instagram] URL diinput: ${url}`);

    // Klik tombol Download
    const buttons = await page.$$('button');
    let downloadBtn = null;
    for (const btn of buttons) {
      const text = await page.evaluate(el => el.textContent?.toLowerCase() || '', btn);
      if (text.includes('download')) {
        downloadBtn = btn;
        break;
      }
    }

    if (!downloadBtn) {
      // Coba submit form
      await inputEl.press('Enter');
    } else {
      await downloadBtn.click();
    }

    // Tunggu hasil muncul
    console.log('[Instagram] Menunggu hasil...');
    await page.waitForFunction(() => {
      const links = document.querySelectorAll('a[href*=".mp4"], a[href*="video"], a[download]');
      return links.length > 0;
    }, { timeout: 30000 }).catch(() => {});

    // Ekstrak download links dari halaman
    const links = await page.evaluate(() => {
      const results = [];
      // Cari link download
      const allLinks = document.querySelectorAll('a');
      for (const a of allLinks) {
        const href = a.href;
        if (href && (href.includes('.mp4') || href.includes('cdninstagram') || href.includes('video') || a.hasAttribute('download'))) {
          results.push(href);
        }
      }
      // Cari video source
      const videos = document.querySelectorAll('video source, video');
      for (const v of videos) {
        const src = v.src || v.getAttribute('src');
        if (src && src.startsWith('http')) {
          results.push(src);
        }
      }
      return [...new Set(results)];
    });

    const allLinks = [...new Set([...downloadLinks, ...links])];

    if (allLinks.length === 0) {
      throw new Error('Tidak ada download link ditemukan. Mungkin private/restricted.');
    }

    console.log(`[Instagram] Ditemukan ${allLinks.length} download link(s)`);
    return { status: 'success', videoUrl: allLinks[0], allUrls: allLinks };

  } catch (err) {
    return { status: 'error', message: err.message };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

/**
 * Download via yt-dlp (fallback, butuh cookies)
 */
async function fetchViaYtDlp(url) {
  return new Promise(async (resolve) => {
    try {
      if (!hasCookies()) {
        resolve({
          status: 'error',
          message: 'Instagram butuh cookies. Upload cookies.txt atau coba link public.',
        });
        return;
      }

      console.log('[Instagram] Fallback ke yt-dlp dengan cookies...');

      const args = [
        '--dump-json',
        '--no-playlist',
        '--no-warnings',
        '--socket-timeout', '30',
        '--cookies', COOKIES_PATH,
        url,
      ];

      const child = spawn('yt-dlp', args, { timeout: 60000 });
      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data) => { stdout += data.toString(); });
      child.stderr.on('data', (data) => { stderr += data.toString(); });

      child.on('close', (code) => {
        if (code !== 0) {
          resolve({ status: 'error', message: stderr.trim() || 'yt-dlp gagal' });
          return;
        }
        try {
          const info = JSON.parse(stdout);
          resolve({
            status: 'success',
            videoUrl: info.url,
            title: info.title || info.description || 'Instagram Video',
            thumbnail: info.thumbnail,
            duration: info.duration,
          });
        } catch {
          resolve({ status: 'error', message: 'Gagal parse yt-dlp output' });
        }
      });
    } catch (err) {
      resolve({ status: 'error', message: err.message });
    }
  });
}

/**
 * Get video info from Instagram URL
 * Try Snapinsta first (no cookies), fallback to yt-dlp
 */
export const getVideoInfo = async (url) => {
  return new Promise(async (resolve) => {
    try {
      const mediaType = getMediaType(url);
      console.log(`[Instagram] Fetching info: ${url} (${mediaType})`);

      // Method 1: Snapinsta (tanpa cookies) — coba dulu
      console.log('[Instagram] Coba Snapinsta (no cookies)...');
      const snapResult = await fetchViaSnapinsta(url);

      if (snapResult.status === 'success') {
        resolve({
          status: 'success',
          title: `Instagram ${mediaType}`,
          videoUrl: snapResult.videoUrl,
          mediaType,
          caption: '',
        });
        return;
      }

      console.log(`[Instagram] Snapinsta gagal: ${snapResult.message}`);

      // Method 2: yt-dlp fallback (butuh cookies)
      console.log('[Instagram] Coba yt-dlp fallback...');
      const ytdlResult = await fetchViaYtDlp(url);

      if (ytdlResult.status === 'success') {
        resolve({
          status: 'success',
          title: ytdlResult.title,
          thumbnail: ytdlResult.thumbnail,
          duration: ytdlResult.duration,
          videoUrl: ytdlResult.videoUrl,
          mediaType,
          caption: '',
        });
        return;
      }

      // Kedua method gagal
      resolve({
        status: 'error',
        message: `❌ Download gagal.\n\nSnapinsta: ${snapResult.message}\nyt-dlp: ${ytdlResult.message}\n\n💡 Coba upload cookies.txt untuk akses private/restricted content.`,
      });
    } catch (err) {
      resolve({ status: 'error', message: err.message });
    }
  });
};

/**
 * Download video file ke local path
 * Coba direct download (axios) dulu, fallback ke yt-dlp
 */
export const downloadVideo = async (url, outputPath) => {
  // Jika URL adalah direct video URL (dari Snapinsta), download langsung
  if (url.includes('.mp4') || url.includes('cdninstagram') || url.includes('video')) {
    try {
      console.log(`[Instagram] Direct download: ${url}`);
      const { data } = await axios({
        url,
        method: 'GET',
        responseType: 'stream',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        timeout: 120000,
      });

      const writer = fs.createWriteStream(outputPath);
      data.pipe(writer);

      return new Promise((resolve, reject) => {
        writer.on('finish', () => {
          console.log(`[Instagram] Downloaded: ${outputPath}`);
          resolve(outputPath);
        });
        writer.on('error', reject);
      });
    } catch (err) {
      console.log(`[Instagram] Direct download gagal: ${err.message}, coba yt-dlp...`);
    }
  }

  // Fallback: yt-dlp
  return new Promise((resolve, reject) => {
    try {
      const args = [
        '--no-playlist',
        '--no-warnings',
        '--socket-timeout', '30',
        '-f', 'best[ext=mp4]/best',
        '--merge-output-format', 'mp4',
        '-o', outputPath,
      ];

      if (hasCookies()) {
        args.push('--cookies', COOKIES_PATH);
      }

      args.push(url);

      console.log(`[Instagram] yt-dlp download: ${url}`);
      const child = spawn('yt-dlp', args, { timeout: 120000 });

      let stderr = '';
      child.stderr.on('data', (data) => { stderr += data.toString(); });

      child.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(stderr.trim() || 'Download gagal'));
          return;
        }

        const dir = path.dirname(outputPath);
        const baseName = path.basename(outputPath, path.extname(outputPath));
        const files = fs.readdirSync(dir).filter(f => 
          f.startsWith(baseName) && (f.endsWith('.mp4') || f.endsWith('.mkv') || f.endsWith('.webm'))
        );

        if (files.length === 0) {
          reject(new Error('File tidak ditemukan setelah download'));
          return;
        }

        const finalPath = path.join(dir, files[0]);
        console.log(`[Instagram] Downloaded: ${finalPath}`);
        resolve(finalPath);
      });

    } catch (err) {
      reject(err);
    }
  });
};

/**
 * Main download function (consistent with douyin/tiktok API pattern)
 */
export const InstagramDL = async (url) => {
  try {
    const info = await getVideoInfo(url);
    if (info.status === 'error') return info;
    return {
      status: 'success',
      title: info.title,
      thumbnail: info.thumbnail,
      videoUrl: info.videoUrl,
      duration: info.duration,
      mediaType: info.mediaType,
      caption: info.caption,
    };
  } catch (err) {
    return { status: 'error', message: err.message };
  }
};
