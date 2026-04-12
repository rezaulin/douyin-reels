# Douyin/TikTok/Instagram → Facebook Reels Bot

Bot Telegram untuk download video Douyin/TikTok/Instagram tanpa watermark, auto-translate caption (China → English), dan upload otomatis ke Facebook Page Reels.

## Fitur

- 📥 Download video Douyin, TikTok & Instagram tanpa watermark
- 📸 Instagram Reels & Posts support (via yt-dlp + cookies)
- 🌐 Auto-translate caption China → English
- 🏷️ Auto-translate hashtags China → English
- 📤 Auto-upload ke Facebook Page Reels (via Graph API)
- 🤖 Bot Telegram (kirim URL langsung dapat video)
- 💻 CLI mode (terminal)
- 📦 Batch mode (proses banyak URL sekaligus)
- 🔄 Auto-compress video > 50MB
- ⏱️ Rate limiting (10 download/hari/user)

## URL yang Didukung

**Douyin:**
- `https://v.douyin.com/xxxxx/`
- `https://www.douyin.com/video/xxxxx`

**TikTok:**
- `https://vm.tiktok.com/xxxxx/`
- `https://www.tiktok.com/@user/video/xxxxx`

**Instagram:**
- `https://www.instagram.com/reel/xxxxx/`
- `https://www.instagram.com/p/xxxxx/`
- `https://www.instagram.com/tv/xxxxx/`

---

## Instalasi

### 1. Install Node.js (minimal v16)

```bash
# Ubuntu/Debian
sudo apt update
sudo apt install nodejs npm -y

# Cek versi
node -v   # harus v16+
npm -v
```

### 2. Clone Repository

```bash
git clone https://github.com/rezaulin/douyin-reels.git
cd douyin-reels
```

### 3. Install Dependencies

```bash
npm install
```

### 4. Install Chromium (untuk Puppeteer)

```bash
npx puppeteer browsers install chrome
```

### 5. Buat File `.env`

```bash
cat > .env << 'EOF'
BOT_TOKEN=token_bot_telegram_kamu
EOF
```

### 6. Edit `config.json`

```json
{
    "pageName": "NamaPageKamu",
    "pageId": "ID_Facebook_Page",
    "pageAccessToken": "Long_Lived_Page_Access_Token",
    "tokenBOT": "Token_Bot_Telegram"
}
```

---

## Cara Mendapatkan Token Telegram Bot

1. Buka Telegram, chat **@BotFather**
2. Ketik `/newbot`
3. Isi nama bot dan username (harus akhiran `bot`)
4. BotFather kasih token, contoh: `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`
5. Copy token → paste di `.env` dan `config.json`

---

## Cara Mendapatkan Facebook Page Access Token (Tahan 60 Hari)

Token Facebook biasa cuma tahan **1-2 jam**. Untuk tahan **60 hari**, ikuti langkah berikut:

### Step 1: Buat Aplikasi di Facebook Developer

1. Buka https://developers.facebook.com/
2. Klik **"Buat Aplikasi"**
3. Pilih jenis: **"Bisnis"**
4. Isi nama aplikasi (contoh: `autopost`)
5. Klik **"Buat Aplikasi"**
6. Catat **App ID** dan **App Secret** (menu: Pengaturan aplikasi → Dasar)

### Step 2: Dapatkan Short-Lived User Token

1. Buka Facebook Graph API Explorer:
   ```
   https://developers.facebook.com/tools/explorer/YOUR_APP_ID/?permissions=pages_read_engagement,pages_manage_posts&method=GET
   ```
   Ganti `YOUR_APP_ID` dengan App ID kamu.

2. Pilih aplikasi di dropdown kanan atas
3. Klik **"Generate Access Token"**
4. Login & izinkan permission:
   - `pages_read_engagement`
   - `pages_manage_posts`
5. Copy token yang muncul (**Short-Lived Token**, tahan ~2 jam)

### Step 3: Tukar ke Long-Lived User Token

Buka browser, akses URL ini (ganti nilai sesuai punya kamu):

```
https://graph.facebook.com/v21.0/oauth/access_token?grant_type=fb_exchange_token&client_id=APP_ID&client_secret=APP_SECRET&fb_exchange_token=SHORT_LIVED_TOKEN
```

| Parameter | Ganti dengan |
|-----------|-------------|
| `APP_ID` | App ID dari Step 1 |
| `APP_SECRET` | App Secret dari Step 1 |
| `SHORT_LIVED_TOKEN` | Token dari Step 2 |

Response akan berisi `access_token` baru (**Long-Lived User Token**, tahan **60 hari**).

### Step 4: Dapatkan Long-Lived Page Token

Buka browser, akses URL ini:

```
https://graph.facebook.com/v21.0/me/accounts?access_token=LONG_LIVED_USER_TOKEN
```

Ganti `LONG_LIVED_USER_TOKEN` dengan token dari Step 3.

Response akan berisi daftar Page yang kamu kelola, masing-masing dengan `access_token` (**Long-Lived Page Token**, tahan **60 hari**).

Copy `access_token` dari Page yang diinginkan → paste di `config.json` pada field `pageAccessToken`.

### Step 5: Verifikasi Token

Cek apakah token valid dan kapan expired:

```
https://graph.facebook.com/v21.0/debug_token?input_token=PAGE_TOKEN&access_token=PAGE_TOKEN
```

Cek field `expires_at` — jika bernilai `0`, token tidak pernah expired. Jika ada angka, convert dari Unix timestamp untuk tahu tanggal expired.

---

## Menjalankan Bot

### Telegram Bot

```bash
node telebot.js
```

Kirim URL Douyin/TikTok ke bot di Telegram, bot akan:
1. Download video tanpa watermark
2. Translate caption China → English
3. Translate hashtags China → English
4. Kirim video ke chat Telegram
5. Upload ke Facebook Page Reels

### CLI Mode

```bash
node index.js
```

Masukkan URL Douyin/TikTok saat diminta.

### Batch Mode

```bash
# Edit urls.txt, satu URL per baris
node index.js --batch
```

---

## Struktur File

```
douyin-reels/
├── index.js           # CLI mode
├── telebot.js         # Telegram Bot
├── douyin-api.js      # Download video Douyin (via Seekin.ai)
├── tiktok-api.js      # Download video TikTok (via Seekin.ai)
├── translate.js       # Auto-translate caption & hashtags (CN → EN)
├── fb-api.js          # Upload ke Facebook Page (Graph API)
├── browserHandler.js  # Browser handler (Facebook upload via Puppeteer)
├── config.json        # Konfigurasi (pageId, token, dll)
├── .env               # Environment variable (BOT_TOKEN)
├── package.json       # Dependencies
├── download/          # Folder hasil download video
└── urls.txt           # Daftar URL untuk batch mode
```

## File yang Di-exclude dari Git

```gitignore
node_modules/      # Dependencies (install ulang via npm install)
download/          # Folder hasil download video
.env               # API keys & bot token
*.mp4              # File video
*.webm             # File video
```

---

## Troubleshooting

### "invalid bot token"
- Cek file `.env`, pastikan `BOT_TOKEN` benar
- Cek file `config.json`, pastikan `tokenBOT` benar

### "Missing X server or $DISPLAY"
- Install Chromium Puppeteer: `npx puppeteer browsers install chrome`
- Pastikan pakai headless mode

### "Session has expired"
- Token Facebook sudah habis
- Ulangi Step 2-4 untuk dapat token baru (tahan 60 hari)

### Download timeout
- CDN Douyin lambat di luar China
- Coba lagi atau pakai VPN

### "Upload Reels gagal"
- Cek `pageAccessToken` di `config.json`
- Pastikan token belum expired
- Pastikan permission: `pages_manage_posts`

---

## License

ISC
