/**
 * Facebook Page Reels Upload via Puppeteer
 * Auto-upload video ke Facebook Page (Halaman) Reels
 */

import puppeteer from 'puppeteer';
import { executablePath } from 'puppeteer';
import moment from 'moment';
import delay from 'delay';
import fs from 'fs-extra';
import path from 'path';

// ── Browser Config ──────────────────────────────────────
const browserOptions = {
  executablePath: executablePath('chrome'),
  headless: false,
  args: [
    '--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    '--no-sandbox',
    '--mute-audio',
    '--disable-notifications',
    '--window-size=1280,900',
  ],
};

const browserPageOpt = { waitUntil: 'networkidle0', timeout: 30000 };

// ── Facebook Page Config ────────────────────────────────
// Baca dari config.json
function loadPageConfig() {
  try {
    const configPath = path.resolve('./config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return {
      pageName: config.pageName || '',        // Nama Halaman (untuk switch ke Page)
      pageId: config.pageId || '',            // ID Halaman (opsional, untuk direct URL)
      pageUrl: config.pageUrl || '',          // URL langsung ke Page Creator (opsional)
    };
  } catch {
    return { pageName: '', pageId: '', pageUrl: '' };
  }
}

// ── Facebook Reels Selectors (Page Mode) ────────────────
const SELECTORS = {
  // ── Switch to Page (dari profil pribadi) ──
  // Menu dropdown di pojok kanan atas (untuk switch identitas)
  accountSwitcher: '[aria-label="Account Switcher"], [data-testid="keychain_login_button"]',
  // Teks "See all profiles" atau nama Page dalam switcher
  seeAllProfiles: 'span:has-text("See all profiles"), span:has-text("Lihat semua profil")',
  // Nama Page dalam daftar (dinamis, dibuat dari config)
  pageListItem: (pageName) => `div[role="listitem"] span:has-text("${pageName}"), a[role="link"] span:has-text("${pageName}")`,

  // ── Page Reels Creator URL ──
  // Format 1: https://www.facebook.com/{pageId}/reels/create/
  // Format 2: https://www.facebook.com/reels/create/ (setelah switch ke Page)

  // ── Upload button ──
  uploadButton: '/html/body/div[1]/div/div[1]/div/div[3]/div/div/div[1]/form/div/div/div[1]/div/div[2]/div[1]/div[2]/div/div/div[1]/div/div/div/div/div/div[1]',
  // Alternatif selector (lebih stabil)
  uploadButtonAlt: 'div[role="button"]:has-text("Select"), div[role="button"]:has-text("Pilih"), div[role="button"]:has-text("Upload")',

  // ── Next buttons ──
  nextButton1: '//*[starts-with(@id, "mount")]/div/div[1]/div/div[3]/div/div/div[1]/form/div/div/div[1]/div/div[3]/div[2]/div/div/div',
  nextButton2: '//*[starts-with(@id, "mount")]/div/div[1]/div/div[3]/div/div/div[1]/form/div/div/div[1]/div/div[3]/div[2]/div[2]/div[1]/div',
  nextButton3: '/html/body/div[1]/div/div[1]/div/div[3]/div/div/div[1]/form/div/div/div[1]/div/div[3]/div[2]/div[2]/div[1]',

  // ── Caption ──
  textArea: '//*[starts-with(@id, "mount")]/div/div[1]/div/div[3]/div/div/div[1]/form/div/div/div[1]/div/div[2]/div[1]/div[2]/div/div/div/div/div[1]/div[1]/div[1]',

  // ── Publish ──
  publishButton: '/html/body/div[1]/div/div[1]/div/div[3]/div/div/div[1]/form/div/div/div[1]/div/div[3]/div[2]/div[2]/div[1]/div/div[1]/div',

  // ── Success ──
  successIndicator: '/html/body/div[1]/div/div[1]/div/div[5]/div/div/div[3]/div[2]/div/div/div[1]/div/div/div/div/div[2]/div[1]/div/div/div[2]/div[2]',

  // ── 90s detector ──
  longVideoDetector: '/html/body/div[1]/div/div[1]/div/div[3]/div/div/div[1]/form/div/div/div[1]/div/div[3]/div[1]/div[1]/div/div/div/div[2]/div/div/div/div/span/span',
  cutVideoButton: '/html/body/div[1]/div/div[1]/div/div[3]/div/div/div[1]/form/div/div/div[1]/div/div[2]/div[1]/div[2]/div/div/div/div/div/div/div[1]/div/div',
};

// ── Helper Functions ────────────────────────────────────

function checkSession() {
  return new Promise(async (resolve) => {
    try {
      const fullPath = path.resolve('./cookies.json');
      const cookies = JSON.parse(await fs.readFile(fullPath));
      resolve(cookies.length > 0);
    } catch {
      resolve(false);
    }
  });
}

function printLog(str, color = 'white') {
  const timestamp = moment().format('HH:mm:ss');
  const colors = {
    white: '\x1b[0m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
  };
  const reset = '\x1b[0m';
  console.log(`${colors[color] || ''}[${timestamp}] ${str}${reset}`);
}

/**
 * Switch ke Facebook Page (Halaman)
 */
async function switchToPage(page, pageName) {
  try {
    printLog(`Mencoba switch ke Page: "${pageName}"...`, 'blue');

    // Buka menu account switcher (pojok kanan atas)
    // Coba beberapa selector untuk account switcher
    const switcherSelectors = [
      '[aria-label="Account Switcher"]',
      '[data-testid="keychain_login_button"]',
      'div[role="banner"] [role="button"][tabindex="0"]',
    ];

    let switcher = null;
    for (const sel of switcherSelectors) {
      switcher = await page.$(sel);
      if (switcher) break;
      await delay(1000);
    }

    if (!switcher) {
      printLog('Account Switcher tidak ditemukan, coba cara lain...', 'yellow');
      // Coba navigasi langsung ke Page
      return await navigateToPageDirect(page, pageName);
    }

    await switcher.click();
    await delay(2000);

    // Cari "See all profiles" atau langsung nama Page
    const seeAllBtn = await page.$x('//span[contains(text(), "See all profiles") or contains(text(), "Lihat semua profil")]');
    if (seeAllBtn.length) {
      await seeAllBtn[0].click();
      await delay(2000);

      // Cari nama Page dalam daftar
      const pageNameLower = pageName.toLowerCase();
      const allLinks = await page.$$('a[role="link"], div[role="listitem"]');

      for (const link of allLinks) {
        const text = await page.evaluate(el => el.textContent?.toLowerCase() || '', link);
        if (text.includes(pageNameLower)) {
          printLog(`Menemukan Page: "${pageName}"`, 'green');
          await link.click();
          await delay(3000);
          return true;
        }
      }

      printLog(`Page "${pageName}" tidak ditemukan dalam daftar`, 'yellow');
      return false;
    }

    // Jika nama Page langsung muncul di dropdown
    const pageBtn = await page.$x(`//span[contains(text(), "${pageName}")]`);
    if (pageBtn.length) {
      await pageBtn[0].click();
      await delay(3000);
      printLog(`Berhasil switch ke Page: "${pageName}"`, 'green');
      return true;
    }

    return false;
  } catch (err) {
    printLog(`Switch ke Page gagal: ${err.message}`, 'yellow');
    return false;
  }
}

/**
 * Navigasi langsung ke Page (tanpa switch)
 */
async function navigateToPageDirect(page, pageName) {
  try {
    // Cari Page ID dari Facebook search
    printLog(`Mencari Page: "${pageName}"...`, 'blue');

    // Coba akses langsung ke Page
    // Format: https://www.facebook.com/search/top?q=PAGE_NAME
    const searchUrl = `https://www.facebook.com/search/pages/?q=${encodeURIComponent(pageName)}`;
    await page.goto(searchUrl, browserPageOpt);
    await delay(3000);

    // Klik hasil pertama
    const firstResult = await page.$('a[role="link"]');
    if (firstResult) {
      await firstResult.click();
      await delay(3000);

      // Dapatkan URL Page
      const pageUrl = page.url();
      printLog(`Page URL: ${pageUrl}`, 'blue');
      return true;
    }

    return false;
  } catch (err) {
    printLog(`Navigasi ke Page gagal: ${err.message}`, 'yellow');
    return false;
  }
}

/**
 * Verifikasi bahwa kita sedang dalam mode Page
 */
async function verifyPageMode(page, pageName) {
  try {
    // Cek apakah URL mengandung page ID
    const currentUrl = page.url();
    if (currentUrl.includes('/reels/create') && pageName) {
      // Cek apakah nama Page muncul di halaman
      const bodyText = await page.evaluate(() => document.body?.innerText || '');
      if (bodyText.toLowerCase().includes(pageName.toLowerCase())) {
        printLog(`Mode Page terkonfirmasi: "${pageName}"`, 'green');
        return true;
      }
    }

    // Cek meta tag atau title
    const title = await page.title();
    if (title.toLowerCase().includes(pageName.toLowerCase())) {
      printLog(`Mode Page terkonfirmasi via title: "${pageName}"`, 'green');
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Upload video ke Facebook Page Reels
 * 
 * @param {string} namafile - Nama file tanpa ekstensi
 * @param {string} caption - Caption untuk Reels
 * @returns {Promise<Object>} Status upload
 */
export const ReelsUpload = (namafile, caption) => new Promise(async (resolve) => {
  let browser;

  try {
    browser = await puppeteer.launch(browserOptions);
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    const hasSession = await checkSession();
    if (!hasSession) {
      await browser.close();
      printLog('ERROR: cookies.json tidak ditemukan!', 'red');
      return resolve({ status: 'error', message: 'Session tidak ditemukan. Export cookies.json dari Chrome.' });
    }

    // Load cookies
    const cookiesPath = path.resolve('./cookies.json');
    const cookies = JSON.parse(await fs.readFile(cookiesPath));
    await page.setCookie(...cookies);
    printLog('Session ditemukan, membuka Facebook...', 'blue');

    // Load Page config
    const pageConfig = loadPageConfig();

    // ── Step 1: Switch ke Page (jika dikonfigurasi) ──
    if (pageConfig.pageName) {
      // Buka Facebook dulu untuk switch
      await page.goto('https://www.facebook.com/', browserPageOpt);
      await delay(2000);

      const switched = await switchToPage(page, pageConfig.pageName);
      if (!switched) {
        printLog('Gagal switch ke Page, upload ke profil pribadi...', 'yellow');
      }
    }

    // ── Step 2: Buka Reels Creator ──
    let reelsUrl = 'https://www.facebook.com/reels/create';

    // Jika ada pageId, gunakan URL khusus Page
    if (pageConfig.pageId) {
      reelsUrl = `https://www.facebook.com/${pageConfig.pageId}/reels/create/`;
      printLog(`Menggunakan URL Page khusus: ${reelsUrl}`, 'blue');
    }

    await page.goto(reelsUrl, browserPageOpt);
    printLog('Berhasil membuka Facebook Reels Creator', 'green');

    // ── Step 3: Verifikasi Page Mode ──
    if (pageConfig.pageName) {
      await delay(2000);
      await verifyPageMode(page, pageConfig.pageName);
    }

    // Step 1: Upload video file
    const uploadElement = await page.$x(SELECTORS.uploadButton);
    if (!uploadElement.length) {
      throw new Error('Upload button tidak ditemukan');
    }

    const [fileChooser] = await Promise.all([
      page.waitForFileChooser({ timeout: 10000 }),
      uploadElement[0].click(),
    ]);

    await delay(2000);

    const videoPath = path.resolve(`./download/${namafile}.mp4`);
    if (!fs.existsSync(videoPath)) {
      throw new Error(`Video file tidak ditemukan: ${videoPath}`);
    }

    await fileChooser.accept([videoPath]);
    printLog(`Video ${namafile}.mp4 berhasil diupload`, 'green');

    await delay(5000);

    // Step 2: Click Next
    const nextElement1 = await page.$x(SELECTORS.nextButton1);
    if (nextElement1.length) {
      await nextElement1[0].click();
      await delay(2000);
    }

    // Step 3: Check if video > 90 detik
    const longVideo = await page.$x(SELECTORS.longVideoDetector);
    if (longVideo.length > 0) {
      printLog('WARNING: Video lebih dari 90 detik, tidak bisa diupload ke Reels', 'red');
      const cutButton = await page.$x(SELECTORS.cutVideoButton);
      if (cutButton.length) await cutButton[0].click();
      await browser.close();
      return resolve({ status: 'error', message: 'Video lebih dari 90 detik!' });
    }

    printLog('Durasi video OK (< 90 detik)', 'green');

    // Step 4: Click Next lagi
    const nextElement2 = await page.$x(SELECTORS.nextButton2);
    if (nextElement2.length) {
      await nextElement2[0].click();
      await delay(2000);
    }

    // Step 5: Input caption
    const textAreaElement = await page.$x(SELECTORS.textArea);
    if (textAreaElement.length) {
      await textAreaElement[0].click();
      // Bersihkan caption dari karakter khusus yang bisa bermasalah
      const cleanCaption = caption.replace(/[^\w\s\u4e00-\u9fff.,!?#@\-\n]/g, '').substring(0, 2200);
      await textAreaElement[0].type(cleanCaption, { delay: 20 });
      printLog('Caption berhasil diinput', 'green');
    }

    await delay(2000);

    // Step 6: Tunggu publish button enabled
    printLog('Menunggu tombol Publish aktif...', 'yellow');
    let publishEnabled = false;
    let waitCount = 0;

    do {
      const [element] = await page.$x(SELECTORS.nextButton3);
      if (element) {
        const disabled = await page.evaluate(el => el.getAttribute('aria-disabled'), element);
        publishEnabled = !disabled;
      }
      if (!publishEnabled) {
        await delay(2000);
        waitCount++;
      }
    } while (!publishEnabled && waitCount < 30);

    if (!publishEnabled) {
      printLog('Tombol Publish tidak aktif setelah 60 detik', 'red');
      await browser.close();
      return resolve({ status: 'error', message: 'Gagal publish - tombol tidak aktif' });
    }

    // Step 7: Click Publish!
    const publishButton = await page.$x(SELECTORS.publishButton);
    if (publishButton.length) {
      await publishButton[0].click();
      printLog('Menekan tombol Publish...', 'yellow');
    }

    // Step 8: Tunggu konfirmasi
    try {
      await page.waitForXPath(SELECTORS.successIndicator, { timeout: 100000 });
      await browser.close();
      printLog('Video berhasil dipublish ke Facebook Reels!', 'green');
      return resolve({ status: 'success', message: 'Video berhasil dipublish ke Facebook Reels!' });
    } catch {
      await browser.close();
      printLog('Timeout menunggu konfirmasi publish', 'yellow');
      return resolve({ status: 'success', message: 'Video kemungkinan berhasil dipublish (timeout konfirmasi)' });
    }

  } catch (err) {
    printLog(`ERROR: ${err.message}`, 'red');
    if (browser) await browser.close();
    return resolve({ status: 'error', message: err.message });
  }
});
