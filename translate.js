/**
 * Auto-Translate Caption
 * Translate dari bahasa China/Inggris ke Indonesia
 * 
 * API: MyMemory (free, 5000 chars/hari, tanpa key)
 * Atau: Google Translate (free, tanpa key)
 */

import axios from 'axios';

/**
 * Deteksi bahasa dari text
 */
function detectLanguage(text) {
  // Cek karakter Cina
  const chineseRegex = /[\u4e00-\u9fff\u3400-\u4dbf]/;
  if (chineseRegex.test(text)) return 'zh';

  // Cek karakter Jepang (Hiragana/Katakana)
  const japaneseRegex = /[\u3040-\u309f\u30a0-\u30ff]/;
  if (japaneseRegex.test(text)) return 'ja';

  // Cek karakter Korea
  const koreanRegex = /[\uac00-\ud7af\u1100-\u11ff]/;
  if (koreanRegex.test(text)) return 'ko';

  // Default: English
  return 'en';
}

/**
 * Translate text menggunakan MyMemory API
 */
async function translateMyMemory(text, from = 'auto', to = 'id') {
  try {
    const langPair = `${from}|${to}`;
    const res = await axios.get('https://api.mymemory.translated.net/get', {
      params: {
        q: text.substring(0, 5000),
        langpair: langPair,
      },
      timeout: 15000,
    });

    if (res.data?.responseData?.translatedText) {
      return res.data.responseData.translatedText;
    }
    return null;
  } catch (err) {
    console.error('[Translate] MyMemory error:', err.message);
    return null;
  }
}

/**
 * Translate text menggunakan Google Translate (unofficial)
 */
async function translateGoogle(text, from = 'auto', to = 'id') {
  try {
    const res = await axios.get(
      `https://translate.googleapis.com/translate_a/single`,
      {
        params: {
          client: 'gtx',
          sl: from,
          tl: to,
          dt: 't',
          q: text.substring(0, 5000),
        },
        timeout: 15000,
      }
    );

    // Response: [[["translated","original",...],...],...]
    if (res.data?.[0]) {
      return res.data[0].map(item => item[0]).join('');
    }
    return null;
  } catch (err) {
    console.error('[Translate] Google error:', err.message);
    return null;
  }
}

/**
 * Translate text ke bahasa target
 * 
 * @param {string} text - Text yang mau di-translate
 * @param {string} targetLang - Bahasa target (default: 'en' = English)
 * @returns {Promise<Object>} { original, translated, detectedLang }
 */
export async function translate(text, targetLang = 'en') {
  if (!text || text.trim().length === 0) {
    return { original: '', translated: '', detectedLang: 'unknown' };
  }

  // Deteksi bahasa
  const detectedLang = detectLanguage(text);

  // Jika sudah bahasa target, return as-is
  if (detectedLang === targetLang) {
    return {
      original: text,
      translated: text,
      detectedLang,
    };
  }

  console.log(`[Translate] ${detectedLang} → ${targetLang}: "${text.substring(0, 50)}..."`);

  // Coba Google Translate dulu (lebih cepat)
  let translated = await translateGoogle(text, detectedLang, targetLang);

  // Fallback ke MyMemory
  if (!translated) {
    console.log('[Translate] Google gagal, coba MyMemory...');
    translated = await translateMyMemory(text, detectedLang, targetLang);
  }

  if (translated) {
    console.log(`[Translate] Hasil: "${translated.substring(0, 50)}..."`);
    return {
      original: text,
      translated,
      detectedLang,
    };
  }

  // Jika semua gagal, return original
  console.log('[Translate] Semua API gagal, return original');
  return {
    original: text,
    translated: text,
    detectedLang,
  };
}

/**
 * Translate caption Douyin/TikTok
 * Handle: deskripsi + hashtags (tanpa duplikat)
 * 
 * @param {string} caption - Full caption dari video
 * @param {string} targetLang - Bahasa target
 * @returns {Promise<string>} Caption yang sudah di-translate
 */
export async function translateCaption(caption, targetLang = 'en') {
  if (!caption) return '';

  // Pisahkan hashtags dari caption
  const hashtagRegex = /#\S+/g;
  const rawHashtags = caption.match(hashtagRegex) || [];
  const textWithoutHashtags = caption.replace(hashtagRegex, '').trim();

  // Translate bagian teks (tanpa hashtags)
  let translatedText = textWithoutHashtags;
  if (textWithoutHashtags) {
    const result = await translate(textWithoutHashtags, targetLang);
    translatedText = result.translated;
  }

  // Translate hashtags China ke Indonesia + pertahankan yang universal
  const allHashtags = new Set();
  
  for (const tag of rawHashtags) {
    const cleanTag = tag.replace('#', '');
    const translated = HASHTAG_MAP[cleanTag];
    
    if (translated) {
      // Hashtag China → tambah versi Indonesia
      allHashtags.add(translated);
    } else if (/^[\u4e00-\u9fff]/.test(cleanTag)) {
      // Hashtag China yang tidak ada di map → skip (tidak dimengerti audience Indonesia)
    } else {
      // Hashtag universal (Inggris) → pertahankan
      allHashtags.add('#' + cleanTag.toLowerCase());
    }
  }

  // Gabungkan
  const finalHashtags = [...allHashtags].join(' ');
  const finalCaption = finalHashtags 
    ? `${translatedText}\n\n${finalHashtags}`
    : translatedText;

  return finalCaption.substring(0, 2200);
}

// ── Hashtag Map: China → English ────────────────────────
const HASHTAG_MAP = {
  // Animals/Nature
  '动物世界': '#animalworld',
  '动物解说': '#animalfacts',
  '狮子': '#lion',
  '老虎': '#tiger',
  '野生动物': '#wildlife',
  '野生动物零距离': '#wildlife',
  '青年创作者成长计划': '',
  
  // General
  '搞笑': '#funny',
  '搞笑视频': '#funnyvideos',
  '美食': '#food',
  '美食分享': '#foodie',
  '舞蹈': '#dance',
  '音乐': '#music',
  '旅行': '#travel',
  '风景': '#scenery',
  '宠物': '#pets',
  '教程': '#tutorial',
  '生活': '#lifestyle',
  '日常': '#daily',
  '运动': '#sports',
  '健身': '#fitness',
  '穿搭': '#fashion',
  '美妆': '#beauty',
  '萌宠': '#cutepets',
  '情感': '#emotions',
  '故事': '#story',
  '历史': '#history',
  
  // Douyin specific
  '抖音': '#douyin',
  '热门': '#trending',
  '推荐': '#recommended',
};
