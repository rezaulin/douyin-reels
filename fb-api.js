/**
 * Facebook Graph API - Upload video ke Page
 * Pakai Page Access Token, bukan cookies
 * 
 * Cara dapat Page Access Token:
 * 1. Buka https://developers.facebook.com/
 * 2. Buat App → tambah permission pages_read_engagement, pages_manage_posts
 * 3. Dapatkan Page Access Token dari Graph API Explorer
 * 4. Konversi ke Long-Lived Token (60 hari)
 */

import axios from 'axios';
import fs from 'fs';
import path from 'path';
import FormData from 'form-data';

const GRAPH_API = 'https://graph.facebook.com/v21.0';

// Load config
function loadConfig() {
  try {
    const configPath = path.resolve('./config.json');
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch {
    return {};
  }
}

/**
 * Cek apakah token valid dan ambil info Page
 */
export async function getPageInfo() {
  const config = loadConfig();
  const pageId = config.pageId;
  const token = config.pageAccessToken;

  if (!pageId || !token) {
    return { status: 'error', message: 'pageId atau pageAccessToken tidak ada di config.json' };
  }

  try {
    const res = await axios.get(`${GRAPH_API}/${pageId}`, {
      params: {
        fields: 'id,name,fan_count,category,about',
        access_token: token,
      },
      timeout: 10000,
    });

    return { status: 'success', data: res.data };
  } catch (err) {
    return {
      status: 'error',
      message: err.response?.data?.error?.message || err.message,
    };
  }
}

/**
 * Upload video ke Facebook Page
 * 
 * @param {string} videoPath - Path ke file video lokal
 * @param {string} title - Judul video
 * @param {string} description - Deskripsi/caption
 * @returns {Promise<Object>}
 */
export async function uploadVideo(videoPath, title = '', description = '') {
  const config = loadConfig();
  const pageId = config.pageId;
  const token = config.pageAccessToken;

  if (!pageId || !token) {
    return { status: 'error', message: 'pageId atau pageAccessToken tidak ada di config.json' };
  }

  if (!fs.existsSync(videoPath)) {
    return { status: 'error', message: `Video tidak ditemukan: ${videoPath}` };
  }

  const fileSize = fs.statSync(videoPath).size;
  console.log(`[FB] Upload: ${path.basename(videoPath)} (${(fileSize / 1024 / 1024).toFixed(2)} MB)`);

  try {
    // Upload video ke Page
    const form = new FormData();
    form.append('source', fs.createReadStream(videoPath));
    form.append('access_token', token);
    if (title) form.append('title', title.substring(0, 200));
    if (description) form.append('description', description.substring(0, 2000));

    const res = await axios.post(`${GRAPH_API}/${pageId}/videos`, form, {
      headers: form.getHeaders(),
      timeout: 300000, // 5 menit timeout
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });

    console.log(`[FB] Upload berhasil! Video ID: ${res.data.id}`);

    return {
      status: 'success',
      data: {
        videoId: res.data.id,
        url: `https://www.facebook.com/${pageId}/videos/${res.data.id}`,
      },
      message: `Video berhasil diupload ke Page! ID: ${res.data.id}`,
    };
  } catch (err) {
    const errMsg = err.response?.data?.error?.message || err.message;
    const errCode = err.response?.data?.error?.code;
    console.error(`[FB] Upload gagal: ${errMsg} (code: ${errCode})`);
    return {
      status: 'error',
      message: errMsg,
      code: errCode,
    };
  }
}

/**
 * Cek status video (apakah sudah selesai diproses)
 */
export async function getVideoStatus(videoId) {
  const config = loadConfig();
  const token = config.pageAccessToken;

  try {
    const res = await axios.get(`${GRAPH_API}/${videoId}`, {
      params: {
        fields: 'id,status,permalink_url,thumbnails',
        access_token: token,
      },
      timeout: 10000,
    });

    return { status: 'success', data: res.data };
  } catch (err) {
    return {
      status: 'error',
      message: err.response?.data?.error?.message || err.message,
    };
  }
}

/**
 * Post foto ke Page (untuk image posts dari Douyin)
 */
export async function postPhoto(imageUrl, message = '') {
  const config = loadConfig();
  const pageId = config.pageId;
  const token = config.pageAccessToken;

  try {
    const res = await axios.post(`${GRAPH_API}/${pageId}/photos`, {
      url: imageUrl,
      message: message.substring(0, 2000),
      access_token: token,
    }, { timeout: 30000 });

    return {
      status: 'success',
      data: res.data,
      message: `Foto berhasil dipost! ID: ${res.data.id}`,
    };
  } catch (err) {
    return {
      status: 'error',
      message: err.response?.data?.error?.message || err.message,
    };
  }
}
