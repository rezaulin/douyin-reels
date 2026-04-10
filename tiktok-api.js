/**
 * TikTok Video Downloader API
 * Menggunakan Seekin.ai sebagai backend (tanpa watermark)
 * 
 * Support URL:
 *   - https://www.tiktok.com/@user/video/xxx
 *   - https://vm.tiktok.com/xxxxx/
 *   - https://vt.tiktok.com/xxxxx/
 *   - https://www.tiktok.com/t/xxxxx/
 */

import puppeteer from 'puppeteer';
import { executablePath } from 'puppeteer';
import axios from 'axios';
import fs from 'fs';

const SEEKIN_URL = 'https://www.seekin.ai/download-tiktok-no-watermark/';

const browserOpts = {
  executablePath: executablePath('chrome'),
  headless: 'new',
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
  ],
};

/**
 * Fetch video info dari TikTok URL via Seekin
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

    console.log('[TikTok] Membuka Seekin.ai...');
    await page.goto(SEEKIN_URL, { waitUntil: 'networkidle2', timeout: 30000 });

    // Tunggu input field
    await page.waitForSelector('input[type="text"], textarea', { timeout: 10000 });

    const inputEl = await page.$('input[type="text"]') || await page.$('textarea');
    if (!inputEl) {
      throw new Error('Input field tidak ditemukan');
    }

    await inputEl.click({ clickCount: 3 });
    await inputEl.type(url, { delay: 10 });
    console.log(`[TikTok] URL diinput: ${url}`);

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
    if (!downloadBtn && buttons.length > 0) {
      downloadBtn = buttons[buttons.length - 1];
    }
    if (!downloadBtn) {
      throw new Error('Download button tidak ditemukan');
    }

    await downloadBtn.evaluate(btn => btn.click());
    console.log('[TikTok] Tombol Download diklik');

    // Tunggu response API (max 30 detik)
    let waitCount = 0;
    while (!apiResponse && waitCount < 30) {
      await new Promise(r => setTimeout(r, 1000));
      waitCount++;
    }

    if (!apiResponse) {
      throw new Error('Timeout menunggu response dari Seekin API');
    }

    console.log('[TikTok] API Response:', JSON.stringify(apiResponse).substring(0, 300));

    // Parse response
    if (apiResponse.code === '0000' || apiResponse.code === 0 || apiResponse.success) {
      return parseResponse(apiResponse, url);
    }

    // Error handling
    if (apiResponse.code === '5016' || apiResponse.code === 5016) {
      return { status: 'error', message: 'Video TikTok tidak ditemukan atau sudah dihapus.' };
    }

    return { status: 'error', message: `Seekin API error: ${apiResponse.msg || 'Unknown'} (code: ${apiResponse.code})` };

  } catch (err) {
    console.error('[TikTok] Error:', err.message);
    return { status: 'error', message: err.message };
  } finally {
    if (browser) await browser.close();
  }
}

/**
 * Parse Seekin API response untuk TikTok
 * 
 * Response format dari Seekin:
 * {
 *   code: "0000",
 *   data: {
 *     title: "...",
 *     imageUrl: "cover_url",
 *     duration: null,
 *     medias: [{ url: "video_url", format: null, ... }],
 *     images: []
 *   }
 * }
 * 
 * Atau format Douyin-style:
 * {
 *   video: { play_addr: { url_list: [...] }, cover: { url_list: [...] } },
 *   desc: "...", ...
 * }
 */
function parseResponse(data, originalUrl) {
  try {
    const result = data.data || data;

    const videos = [];

    // Format 1: Seekin TikTok → medias[].url
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
    if (result.nowm) videos.push(result.nowm);
    if (result.download_url) videos.push(result.download_url);

    // Format 4: Array of URLs
    if (Array.isArray(result.urls)) videos.push(...result.urls);

    // Deduplicate & filter valid URLs
    const uniqueVideos = [...new Set(videos)].filter(v => v && typeof v === 'string' && v.startsWith('http'));

    // Cover image
    const cover = result.imageUrl || result.video?.cover?.url_list?.[0] || result.cover || result.thumbnail || '';

    // Extract hashtags dari title
    const title = result.title || result.desc || result.description || '';
    const hashtagMatches = title.match(/#\S+/g) || [];
    const hashtags = hashtagMatches.map(h => h.replace('#', ''));

    return {
      status: 'success',
      result: {
        type: result.images?.length ? 'image' : 'video',
        id: result.aweme_id || result.id || result.video_id || '',
        description: title,
        video: uniqueVideos,
        video_wm: [],
        cover: cover,
        author: {
          unique_id: result.author?.unique_id || result.author_id || '',
          nickname: result.author?.nickname || result.author_nickname || '',
          avatar: result.author?.avatar_thumb?.url_list?.[0] || result.author?.avatar || '',
        },
        duration: result.duration || result.video?.duration || 0,
        likes: result.statistics?.digg_count || 0,
        comments: result.statistics?.comment_count || 0,
        shares: result.statistics?.share_count || 0,
        hashtags: hashtags.length ? hashtags : (result.text_extra?.filter(t => t.hashtag_name).map(t => t.hashtag_name) || []),
        music: {
          title: result.music?.title || '',
          author: result.music?.author || '',
          url: result.music?.play_url?.url_list?.[0] || '',
        },
      },
    };
  } catch (err) {
    return { status: 'error', message: `Parse error: ${err.message}` };
  }
}

// ── Main Export ─────────────────────────────────────────

/**
 * TikTokDL - Download video dari TikTok URL
 * 
 * @param {string} url - TikTok video URL
 * @returns {Promise<Object>} Video data
 */
export const TikTokDL = (url) => new Promise(async (resolve) => {
  try {
    if (!url || (!url.includes('tiktok.com') && !url.includes('vt.tiktok.com') && !url.includes('vm.tiktok.com'))) {
      return resolve({
        status: 'error',
        message: 'URL tidak valid. Gunakan URL dari tiktok.com',
      });
    }

    console.log(`[TikTok] Processing: ${url}`);
    const result = await fetchViaSeekin(url);
    resolve(result);
  } catch (err) {
    resolve({ status: 'error', message: err.message });
  }
});

/**
 * Download video file ke local path
 */
export const downloadVideo = async (url, outputPath) => {
  const { data } = await axios({
    url,
    method: 'GET',
    responseType: 'stream',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
    timeout: 60000,
  });

  const writer = fs.createWriteStream(outputPath);
  data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
};
