/**
 * Douyin (抖音) Video Downloader API
 * Menggunakan Seekin.ai sebagai backend untuk bypass geo-restriction
 * 
 * Support URL:
 *   - https://v.douyin.com/xxxxx/ (share URL)
 *   - https://www.douyin.com/video/xxxxx (direct URL)
 *   - https://www.douyin.com/discover?modal_id=xxxxx
 */

import puppeteer from 'puppeteer';
import axios from 'axios';
import fs from 'fs';
import path from 'path';

const SEEKIN_URL = 'https://www.seekin.ai/douyin-downloader/';

// ── Browser Config ──────────────────────────────────────
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
 * Extract video info dari Douyin URL menggunakan Seekin.ai
 * 
 * @param {string} url - Douyin video URL
 * @returns {Promise<Object>} Video data dengan download URLs
 */
async function fetchViaSeekin(url) {
  let browser;

  try {
    browser = await puppeteer.launch(browserOpts);
    const page = await browser.newPage();

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );
    await page.setViewport({ width: 1280, height: 800 });

    // Intercept API responses
    let apiResponse = null;
    page.on('response', async (response) => {
      const respUrl = response.url();
      if (respUrl.includes('ikool') || respUrl.includes('media/download')) {
        try {
          const data = await response.json();
          apiResponse = data;
        } catch {}
      }
    });

    // Navigate ke Seekin Douyin downloader
    console.log('[Douyin] Membuka Seekin.ai...');
    await page.goto(SEEKIN_URL, { waitUntil: 'networkidle2', timeout: 30000 });

    // Tunggu input field
    await page.waitForSelector('input[type="text"], textarea', { timeout: 10000 });

    // Cari input field
    const inputEl = await page.$('input[type="text"]') || await page.$('textarea');
    if (!inputEl) {
      throw new Error('Input field tidak ditemukan di Seekin');
    }

    // Clear dan paste URL
    await inputEl.click({ clickCount: 3 });
    await inputEl.type(url, { delay: 10 });
    console.log(`[Douyin] URL diinput: ${url}`);

    // Cari dan klik tombol Download
    const buttons = await page.$$('button');
    let downloadBtn = null;
    for (const btn of buttons) {
      const text = await page.evaluate(el => el.textContent?.toLowerCase() || '', btn);
      if (text.includes('download')) {
        downloadBtn = btn;
        break;
      }
    }
    if (!downloadBtn && buttons.length > 0) {
      // Fallback: klik button pertama setelah input
      downloadBtn = buttons[buttons.length - 1];
    }
    if (!downloadBtn) {
      throw new Error('Download button tidak ditemukan');
    }

    // Klik download
    await downloadBtn.evaluate(btn => btn.click());
    console.log('[Douyin] Tombol Download diklik');

    // Tunggu response API (max 30 detik)
    let waitCount = 0;
    while (!apiResponse && waitCount < 30) {
      await new Promise(r => setTimeout(r, 1000));
      waitCount++;
    }

    if (!apiResponse) {
      throw new Error('Timeout menunggu response dari Seekin API');
    }

    console.log('[Douyin] API Response:', JSON.stringify(apiResponse).substring(0, 300));

    // Parse response
    if (apiResponse.code === '0000' || apiResponse.code === 0 || apiResponse.success) {
      return parseSeekinResponse(apiResponse, url);
    }

    // Cek error code
    if (apiResponse.code === '5016' || apiResponse.code === 5016) {
      return { status: 'error', message: 'Video tidak ditemukan atau sudah dihapus. Pastikan URL Douyin valid.' };
    }

    if (apiResponse.code === '5001' || apiResponse.code === 5001) {
      return { status: 'error', message: 'URL tidak didukung oleh Seekin.' };
    }

    return { status: 'error', message: `Seekin API error: ${apiResponse.msg || 'Unknown'} (code: ${apiResponse.code})` };

  } catch (err) {
    console.error('[Douyin] Error:', err.message);
    return { status: 'error', message: err.message };
  } finally {
    if (browser) await browser.close();
  }
}

/**
 * Parse Seekin API response
 * 
 * Response format:
 * {
 *   code: "0000",
 *   data: {
 *     title: "...",           // TikTok format
 *     imageUrl: "...",
 *     medias: [{ url: "..." }],
 *     // atau Douyin format:
 *     video: { play_addr: { url_list: [...] } },
 *     desc: "..."
 *   }
 * }
 */
function parseSeekinResponse(data, originalUrl) {
  try {
    const result = data.data || data;

    const videos = [];

    // Format 1: Seekin TikTok-style → medias[].url
    if (result.medias && Array.isArray(result.medias)) {
      for (const m of result.medias) {
        if (m.url) videos.push(m.url);
      }
    }

    // Format 2: Douyin-style video object
    if (result.video?.play_addr?.url_list) {
      videos.push(...result.video.play_addr.url_list);
    }
    if (result.video?.download_addr?.url_list) {
      videos.push(...result.video.download_addr.url_list);
    }

    // Format 3: Direct URL fields
    if (result.video_url) videos.push(result.video_url);
    if (result.play) videos.push(result.play);
    if (result.url && typeof result.url === 'string') videos.push(result.url);
    if (result.download_url) videos.push(result.download_url);
    if (Array.isArray(result.urls)) videos.push(...result.urls);

    // Deduplicate & filter
    let uniqueVideos = [...new Set(videos)].filter(v => v && typeof v === 'string' && v.startsWith('http'));

    // Urutkan: pilih kualitas terkecil dulu (download lebih cepat)
    if (result.medias && Array.isArray(result.medias)) {
      const sortedMedias = result.medias
        .filter(m => m.url && m.fileSize)
        .sort((a, b) => (a.fileSize || 0) - (b.fileSize || 0));
      if (sortedMedias.length) {
        uniqueVideos = [sortedMedias[0].url, ...uniqueVideos.filter(v => v !== sortedMedias[0].url)];
      }
    }

    // Cover
    const cover = result.imageUrl || result.video?.cover?.url_list?.[0] || result.cover || '';

    // Title/Description
    const title = result.desc || result.description || result.title || '';

    // Hashtags - extract dari title atau dari text_extra
    const hashtagMatches = title.match(/#\S+/g) || [];
    const extractedHashtags = hashtagMatches.map(h => h.replace('#', ''));
    const hashtags = extractedHashtags.length 
      ? extractedHashtags 
      : (result.text_extra?.filter(t => t.hashtag_name).map(t => t.hashtag_name) || []);

    return {
      status: 'success',
      result: {
        type: uniqueVideos.length ? 'video' : (result.images?.length ? 'image' : (result.type || 'video')),
        id: result.aweme_id || result.id || '',
        description: title,
        video: uniqueVideos,
        cover: cover,
        author: {
          unique_id: result.author?.unique_id || result.author_id || '',
          nickname: result.author?.nickname || result.author_nickname || '',
        },
        duration: result.duration || result.video?.duration || 0,
        hashtags: hashtags,
        music: {
          title: result.music?.title || '',
          author: result.music?.author || '',
        },
      },
    };
  } catch (err) {
    return { status: 'error', message: `Parse error: ${err.message}` };
  }
}

/**
 * Extract video data langsung dari halaman Seekin (fallback)
 */
async function extractFromPage(page, url) {
  try {
    // Tunggu sampai halaman menampilkan hasil
    await new Promise(r => setTimeout(r, 5000));

    // Cari video element atau download link
    const pageData = await page.evaluate(() => {
      // Cari video tag
      const video = document.querySelector('video');
      if (video?.src) {
        return { type: 'video', url: video.src };
      }

      // Cari download link
      const links = Array.from(document.querySelectorAll('a[href]'));
      const downloadLinks = links.filter(a =>
        a.href.includes('.mp4') ||
        a.href.includes('download') ||
        a.textContent.toLowerCase().includes('download')
      );

      if (downloadLinks.length) {
        return {
          type: 'links',
          urls: downloadLinks.map(a => ({ href: a.href, text: a.textContent.trim() })),
        };
      }

      // Cari source element
      const source = document.querySelector('source');
      if (source?.src) {
        return { type: 'source', url: source.src };
      }

      return null;
    });

    if (pageData) {
      if (pageData.type === 'video' || pageData.type === 'source') {
        return {
          status: 'success',
          result: {
            type: 'video',
            id: '',
            description: '',
            video: [pageData.url],
            cover: '',
            author: { unique_id: '', nickname: '' },
            duration: 0,
            hashtags: [],
            music: { title: '', author: '' },
          },
        };
      }

      if (pageData.type === 'links' && pageData.urls?.length) {
        return {
          status: 'success',
          result: {
            type: 'video',
            id: '',
            description: '',
            video: pageData.urls.map(l => l.href),
            cover: '',
            author: { unique_id: '', nickname: '' },
            duration: 0,
            hashtags: [],
            music: { title: '', author: '' },
          },
        };
      }
    }

    return { status: 'error', message: 'Tidak bisa extract video dari halaman Seekin' };
  } catch (err) {
    return { status: 'error', message: `Extract error: ${err.message}` };
  }
}

// ── Main Export ─────────────────────────────────────────

/**
 * DouyinDL - Download video dari Douyin URL
 * 
 * @param {string} url - Douyin video URL
 * @returns {Promise<Object>} Video data
 */
export const DouyinDL = (url) => new Promise(async (resolve) => {
  try {
    if (!url || (!url.includes('douyin.com') && !url.includes('v.douyin.com'))) {
      return resolve({
        status: 'error',
        message: 'URL tidak valid. Gunakan URL dari douyin.com atau v.douyin.com',
      });
    }

    console.log(`[Douyin] Processing: ${url}`);
    const result = await fetchViaSeekin(url);
    resolve(result);
  } catch (err) {
    resolve({ status: 'error', message: err.message });
  }
});

/**
 * Download video file ke local path (dengan retry & timeout lebih lama)
 */
export const downloadVideo = async (url, outputPath, retries = 3) => {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`[Download] Attempt ${attempt}/${retries}...`);
      const { data } = await axios({
        url,
        method: 'GET',
        responseType: 'stream',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://www.douyin.com/',
        },
        timeout: 180000, // 3 menit
      });

      const writer = fs.createWriteStream(outputPath);
      data.pipe(writer);

      return new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
      });
    } catch (err) {
      console.log(`[Download] Attempt ${attempt} failed: ${err.message}`);
      if (attempt === retries) throw err;
      // Tunggu 3 detik sebelum retry
      await new Promise(r => setTimeout(r, 3000));
    }
  }
};
