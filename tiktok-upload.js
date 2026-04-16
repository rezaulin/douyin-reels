/**
 * TikTok Upload via Puppeteer Browser Automation
 * Auto-upload video ke TikTok Web Creator
 * 
 * Setup:
 * 1. Login TikTok di Chrome
 * 2. Export cookies: pakai extension "EditThisCookie" atau "Cookie-Editor"
 * 3. Simpan sebagai tiktok-cookies.json di root project
 */

import puppeteer from 'puppeteer';
import delay from 'delay';
import fs from 'fs-extra';
import path from 'path';

// ── Browser Config ──────────────────────────────────────
const browserOptions = {
  headless: 'new',
  args: [
    '--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-extensions',
    '--disable-software-rasterizer',
    '--headless=new',
    '--mute-audio',
    '--disable-notifications',
    '--window-size=1280,900',
  ],
};

// ── Helper ──────────────────────────────────────────────

function log(msg, color = 'white') {
  const colors = {
    white: '\x1b[0m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
  };
  console.log(`${colors[color] || ''}[TikTok] ${msg}\x1b[0m`);
}

/**
 * Load TikTok cookies dari file
 */
async function loadCookies() {
  const cookiesPath = path.resolve('./tiktok-cookies.json');
  if (!await fs.pathExists(cookiesPath)) {
    throw new Error('tiktok-cookies.json tidak ditemukan! Export cookies dari Chrome setelah login TikTok.');
  }
  return JSON.parse(await fs.readFile(cookiesPath, 'utf-8'));
}

/**
 * Cek apakah masih login (ada session cookie)
 */
async function isLoggedIn(page) {
  await page.goto('https://www.tiktok.com/', { waitUntil: 'networkidle2', timeout: 30000 });
  await delay(3000);

  // Cek apakah ada tombol login (berarti belum login)
  const loginBtn = await page.$('button[data-e2e="top-login-button"]');
  if (loginBtn) {
    return false;
  }

  // Cek apakah ada avatar/profile (berarti sudah login)
  const avatar = await page.$('[data-e2e="profile-icon"], [data-e2e="header-avatar"]');
  return !!avatar;
}

/**
 * Upload video ke TikTok via Web Creator
 * 
 * @param {string} videoPath - Path ke file video lokal
 * @param {string} caption - Caption/deskripsi video
 * @param {Object} options - Opsi tambahan
 * @param {boolean} options.isPrivate - Upload sebagai private (default: false)
 * @param {boolean} options.allowComments - Izinkan komentar (default: true)
 * @param {boolean} options.allowDuet - Izinkan duet (default: true)
 * @param {boolean} options.allowStitch - Izinkan stitch (default: true)
 * @returns {Promise<Object>} Status upload
 */
export async function uploadToTikTok(videoPath, caption = '', options = {}) {
  let browser;

  const {
    isPrivate = false,
    allowComments = true,
    allowDuet = true,
    allowStitch = true,
  } = options;

  try {
    // Validasi file
    if (!await fs.pathExists(videoPath)) {
      throw new Error(`Video tidak ditemukan: ${videoPath}`);
    }

    const fileSize = (await fs.stat(videoPath)).size;
    const fileSizeMB = fileSize / 1024 / 1024;
    log(`File: ${path.basename(videoPath)} (${fileSizeMB.toFixed(1)} MB)`, 'blue');

    // TikTok web max ~10GB, tapi kita limit di 20MB sesuai bot config
    if (fileSize > 20 * 1024 * 1024) {
      throw new Error(`File terlalu besar: ${fileSizeMB.toFixed(1)} MB (max 20 MB)`);
    }

    // Launch browser
    browser = await puppeteer.launch(browserOptions);
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    // Load cookies
    log('Loading TikTok session...', 'blue');
    const cookies = await loadCookies();
    await page.setCookie(...cookies);

    // Cek login status
    const loggedIn = await isLoggedIn(page);
    if (!loggedIn) {
      await browser.close();
      throw new Error('Session TikTok expired! Login ulang di Chrome, export cookies baru.');
    }
    log('Session TikTok valid!', 'green');

    // ── Buka Upload Page ─────────────────────────────────
    // TikTok Creator Center upload URL
    const uploadUrl = 'https://www.tiktok.com/creator#/upload?scene=creator_center';
    await page.goto(uploadUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    await delay(5000);

    // Cek apakah halaman upload terbuka
    const currentUrl = page.url();
    log(`URL: ${currentUrl}`, 'blue');

    // ── Upload Video File ────────────────────────────────
    log('Mencari upload input...', 'blue');

    // TikTok pakai <input type="file"> untuk upload
    // Cari file input (biasanya hidden)
    let fileInput = await page.$('input[type="file"][accept*="video"]');

    if (!fileInput) {
      // Coba selector alternatif
      fileInput = await page.$('input[type="file"]');
    }

    if (!fileInput) {
      // Coba trigger file chooser via klik tombol upload
      log('File input tidak ditemukan langsung, coba klik tombol upload...', 'yellow');

      const uploadButtonSelectors = [
        '[data-e2e="upload-btn"]',
        'div[class*="upload"]',
        'button:has-text("Select video")',
        'div:has-text("Select file")',
        'div.drag-upload-area',
        '[class*="DragUpload"]',
        '[class*="upload-area"]',
      ];

      let uploadBtn = null;
      for (const sel of uploadButtonSelectors) {
        try {
          uploadBtn = await page.$(sel);
          if (uploadBtn) break;
        } catch {}
      }

      if (uploadBtn) {
        const [fileChooser] = await Promise.all([
          page.waitForFileChooser({ timeout: 10000 }),
          uploadBtn.click(),
        ]);

        await fileChooser.accept([path.resolve(videoPath)]);
        log('Video diupload via file chooser', 'green');
      } else {
        throw new Error('Tidak menemukan tombol upload atau file input di halaman TikTok');
      }
    } else {
      // Upload langsung via file input
      await fileInput.uploadFile(path.resolve(videoPath));
      log('Video diupload via file input', 'green');
    }

    // ── Tunggu Upload Selesai ────────────────────────────
    log('Menunggu proses upload...', 'yellow');

    // Tunggu sampai video ter-upload (biasanya ada progress bar)
    // TikTok akan redirect ke editor setelah upload selesai
    await delay(10000);

    // Cek apakah ada progress indicator
    let uploadDone = false;
    let waitCount = 0;

    while (!uploadDone && waitCount < 60) {
      // Cek apakah caption editor muncul (artinya upload selesai)
      const captionArea = await page.$(
        'div[contenteditable="true"], ' +
        'textarea[placeholder*="caption"], ' +
        'textarea[placeholder*="deskripsi"], ' +
        'div.public-DraftEditor-content, ' +
        '[data-e2e="caption-input"], ' +
        'div[role="textbox"]'
      );

      if (captionArea) {
        uploadDone = true;
        log('Upload selesai, editor terbuka!', 'green');
        break;
      }

      // Cek error
      const errorEl = await page.$('[class*="error"], [class*="fail"]');
      if (errorEl) {
        const errorText = await page.evaluate(el => el.textContent, errorEl);
        if (errorText && errorText.length > 0 && errorText.length < 200) {
          throw new Error(`Upload error: ${errorText}`);
        }
      }

      await delay(2000);
      waitCount++;
    }

    if (!uploadDone) {
      throw new Error('Timeout menunggu upload selesai (2 menit)');
    }

    await delay(3000);

    // ── Input Caption ────────────────────────────────────
    if (caption) {
      log('Menginput caption...', 'blue');

      // Bersihkan caption
      const cleanCaption = caption
        .replace(/[^\w\s\u4e00-\u9fff.,!?#@\-\/\n:()]/g, '')
        .substring(0, 2200);

      const captionSelectors = [
        'div[contenteditable="true"]',
        'div.public-DraftEditor-content',
        '[data-e2e="caption-input"]',
        'div[role="textbox"]',
        'textarea[placeholder*="caption"]',
        'textarea[placeholder*="deskripsi"]',
      ];

      let captionEl = null;
      for (const sel of captionSelectors) {
        captionEl = await page.$(sel);
        if (captionEl) break;
      }

      if (captionEl) {
        await captionEl.click();
        await delay(500);

        // Clear existing content
        await page.keyboard.down('Control');
        await page.keyboard.press('a');
        await page.keyboard.up('Control');
        await page.keyboard.press('Backspace');
        await delay(300);

        // Type caption
        await captionEl.type(cleanCaption, { delay: 15 });
        log('Caption berhasil diinput', 'green');
      } else {
        log('Caption editor tidak ditemukan, skip...', 'yellow');
      }
    }

    await delay(2000);

    // ── Setting Privacy & Interactions ───────────────────

    // Private/Public toggle
    if (isPrivate) {
      log('Setting: Private', 'blue');
      const privateBtn = await page.$(
        '[data-e2e="privacy-private"], ' +
        'label:has-text("Only you"), ' +
        'label:has-text("Private")'
      );
      if (privateBtn) {
        await privateBtn.click();
        await delay(500);
      }
    }

    // Comments toggle
    if (!allowComments) {
      log('Setting: Disable comments', 'blue');
      const commentToggle = await page.$(
        '[data-e2e="comment-switch"], ' +
        'input[name="comment"]'
      );
      if (commentToggle) {
        await commentToggle.click();
        await delay(500);
      }
    }

    // Duet toggle
    if (!allowDuet) {
      log('Setting: Disable duet', 'blue');
      const duetToggle = await page.$(
        '[data-e2e="duet-switch"], ' +
        'input[name="duet"]'
      );
      if (duetToggle) {
        await duetToggle.click();
        await delay(500);
      }
    }

    // Stitch toggle
    if (!allowStitch) {
      log('Setting: Disable stitch', 'blue');
      const stitchToggle = await page.$(
        '[data-e2e="stitch-switch"], ' +
        'input[name="stitch"]'
      );
      if (stitchToggle) {
        await stitchToggle.click();
        await delay(500);
      }
    }

    await delay(2000);

    // ── Click Post/Upload ────────────────────────────────
    log('Mencari tombol Post...', 'blue');

    const postSelectors = [
      '[data-e2e="upload-post"]',
      'button:has-text("Post")',
      'button:has-text("Upload")',
      'button:has-text("Posting")',
      'div.btn-post',
      'button[class*="post"]',
      'button[class*="upload-btn"]',
    ];

    let postBtn = null;
    for (const sel of postSelectors) {
      try {
        postBtn = await page.$(sel);
        if (postBtn) {
          // Cek apakah button enabled
          const disabled = await page.evaluate(el => {
            return el.disabled || el.getAttribute('aria-disabled') === 'true';
          }, postBtn);

          if (!disabled) break;
          postBtn = null;
        }
      } catch {}
    }

    if (!postBtn) {
      // Coba cari button yang mengandung text "Post"
      const allButtons = await page.$$('button');
      for (const btn of allButtons) {
        const text = await page.evaluate(el => el.textContent?.toLowerCase() || '', btn);
        if (text.includes('post') || text.includes('upload')) {
          const disabled = await page.evaluate(el => el.disabled, btn);
          if (!disabled) {
            postBtn = btn;
            break;
          }
        }
      }
    }

    if (!postBtn) {
      throw new Error('Tombol Post tidak ditemukan atau disabled');
    }

    log('Menekan tombol Post...', 'yellow');
    await postBtn.click();

    // ── Tunggu Konfirmasi ────────────────────────────────
    log('Menunggu konfirmasi upload...', 'yellow');
    await delay(10000);

    // Cek success - biasanya redirect ke video manager atau tampil notifikasi
    const finalUrl = page.url();

    // Cek apakah kembali ke halaman upload (gagal) atau ke halaman lain (sukses)
    if (finalUrl.includes('/upload')) {
      // Mungkin masih processing atau gagal
      // Cek error message
      const errorEl = await page.$('[class*="error"], [class*="toast"], [class*="notification"]');
      if (errorEl) {
        const errorText = await page.evaluate(el => el.textContent, errorEl);
        if (errorText && errorText.toLowerCase().includes('error')) {
          throw new Error(`Upload gagal: ${errorText}`);
        }
      }

      // Mungkin berhasil tapi belum redirect
      log('Upload kemungkinan berhasil (belum redirect)', 'yellow');
    } else {
      log('Berhasil! Redirect dari halaman upload', 'green');
    }

    // Screenshot untuk verifikasi
    const screenshotPath = path.resolve(`./download/tiktok_${Date.now()}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: false });
    log(`Screenshot: ${screenshotPath}`, 'blue');

    await browser.close();

    return {
      status: 'success',
      message: 'Video berhasil diupload ke TikTok!',
      screenshot: screenshotPath,
    };

  } catch (err) {
    log(`ERROR: ${err.message}`, 'red');
    if (browser) await browser.close();
    return {
      status: 'error',
      message: err.message,
    };
  }
}

/**
 * Cek status login TikTok
 */
export async function checkTikTokSession() {
  let browser;
  try {
    browser = await puppeteer.launch(browserOptions);
    const page = await browser.newPage();

    const cookies = await loadCookies();
    await page.setCookie(...cookies);

    const loggedIn = await isLoggedIn(page);
    await browser.close();

    return {
      status: loggedIn ? 'success' : 'error',
      message: loggedIn ? 'Session TikTok valid' : 'Session expired, login ulang',
    };
  } catch (err) {
    if (browser) await browser.close();
    return { status: 'error', message: err.message };
  }
}
