/**
 * Instagram Video Downloader API
 * Menggunakan yt-dlp sebagai backend
 * 
 * Support URL:
 *   - https://www.instagram.com/reel/xxxxx/
 *   - https://www.instagram.com/p/xxxxx/
 *   - https://www.instagram.com/tv/xxxxx/
 *   - https://www.instagram.com/stories/xxxxx/
 */

import { execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import axios from 'axios';

const COOKIES_PATH = path.join(process.cwd(), 'cookies.txt');

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
 * Get video info from Instagram URL via yt-dlp
 */
export const getVideoInfo = async (url) => {
  return new Promise(async (resolve) => {
    try {
      const mediaType = getMediaType(url);
      console.log(`[Instagram] Fetching info: ${url} (${mediaType})`);

      // Build yt-dlp command for metadata only
      const args = [
        '--dump-json',
        '--no-playlist',
        '--no-warnings',
        '--socket-timeout', '30',
      ];

      if (hasCookies()) {
        args.push('--cookies', COOKIES_PATH);
        console.log('[Instagram] Using cookies file');
      }

      args.push(url);

      const child = spawn('yt-dlp', args, { timeout: 60000 });
      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data) => { stdout += data.toString(); });
      child.stderr.on('data', (data) => { stderr += data.toString(); });

      child.on('close', (code) => {
        if (code !== 0) {
          const error = stderr.trim();
          if (error.includes('login required') || error.includes('cookies')) {
            resolve({
              status: 'error',
              message: '⚠️ Instagram butuh login. Upload cookies.txt dulu.\n\nCara export:\n1. Install extension "Get cookies.txt LOCALLY" di Chrome\n2. Buka instagram.com (pastiin login)\n3. Export cookies → upload ke bot',
            });
          } else if (error.includes('rate-limit')) {
            resolve({
              status: 'error',
              message: '⚠️ Rate limit. Coba lagi nanti atau upload cookies.',
            });
          } else {
            resolve({
              status: 'error',
              message: `Download gagal: ${error.substring(0, 200)}`,
            });
          }
          return;
        }

        try {
          const info = JSON.parse(stdout);
          resolve({
            status: 'success',
            title: info.title || info.description || 'Instagram Video',
            thumbnail: info.thumbnail,
            duration: info.duration,
            url: info.url,
            ext: info.ext || 'mp4',
            mediaType,
            caption: info.description || '',
          });
        } catch (parseErr) {
          resolve({
            status: 'error',
            message: 'Gagal parse info video.',
          });
        }
      });

    } catch (err) {
      resolve({ status: 'error', message: err.message });
    }
  });
};

/**
 * Download video file ke local path via yt-dlp
 */
export const downloadVideo = async (url, outputPath) => {
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

      console.log(`[Instagram] Downloading: ${url}`);
      const child = spawn('yt-dlp', args, { timeout: 120000 });

      let stderr = '';
      child.stderr.on('data', (data) => { stderr += data.toString(); });

      child.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(stderr.trim() || 'Download gagal'));
          return;
        }

        // Find downloaded file
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
      videoUrl: info.url,
      duration: info.duration,
      mediaType: info.mediaType,
      caption: info.caption,
    };
  } catch (err) {
    return { status: 'error', message: err.message };
  }
};
