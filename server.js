const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();
const PORT = Number(process.env.PORT || 10000);

app.use(cors({ origin: true, methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"], allowedHeaders: ["Content-Type", "Authorization"] }));
app.use(express.json({ limit: "2mb" }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function db(sql, params = []) { const result = await pool.query(sql, params); return result.rows; }
function hashPassword(password) { return crypto.createHash("sha256").update(String(password)).digest("hex"); }
function safeUser(row) {
  return { id: row.id, username: row.username, email: row.email || "", birth_date: row.birth_date || "", city: row.city || "", avatar: row.avatar || "assets/avatar.svg", is_admin: !!row.is_admin, created_at: row.created_at, last_seen: row.last_seen };
}

async function initDb() {
  await db(`CREATE TABLE IF NOT EXISTS users (id BIGSERIAL PRIMARY KEY, username TEXT NOT NULL UNIQUE, email TEXT DEFAULT '', password_hash TEXT NOT NULL, birth_date TEXT DEFAULT '', city TEXT DEFAULT '', avatar TEXT DEFAULT 'assets/avatar.svg', is_admin BOOLEAN DEFAULT FALSE, created_at TIMESTAMPTZ DEFAULT NOW(), last_seen TIMESTAMPTZ DEFAULT NOW())`);
  await db(`CREATE TABLE IF NOT EXISTS knowledge (id BIGSERIAL PRIMARY KEY, title TEXT NOT NULL DEFAULT '', question TEXT DEFAULT '', answer TEXT NOT NULL DEFAULT '', raw_text TEXT NOT NULL DEFAULT '', type TEXT DEFAULT 'general', enabled BOOLEAN DEFAULT TRUE, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())`);
  await db(`CREATE TABLE IF NOT EXISTS messages (id BIGSERIAL PRIMARY KEY, user_id BIGINT REFERENCES users(id) ON DELETE CASCADE, sender TEXT NOT NULL CHECK (sender IN ('user','assistant')), text TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW())`);
  await db(`CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY DEFAULT 1, agent_name TEXT DEFAULT 'Qamir', brand_name TEXT DEFAULT 'Qamir AI', role TEXT DEFAULT '', instruction TEXT DEFAULT '', must_rules TEXT DEFAULT '', never_rules TEXT DEFAULT '', customer_rules TEXT DEFAULT '', language TEXT DEFAULT 'O‘zbek', tone TEXT DEFAULT 'Samimiy', emoji TEXT DEFAULT 'some', answer_length TEXT DEFAULT 'O‘rtacha', greeting TEXT DEFAULT 'Salom! Men Qamir AI. Sizga qanday yordam beray?', ask_style TEXT DEFAULT '', model TEXT DEFAULT 'gemini-2.5-flash', temperature NUMERIC DEFAULT 0.7, max_tokens INTEGER DEFAULT 1024, updated_at TIMESTAMPTZ DEFAULT NOW())`);
  await db(`CREATE TABLE IF NOT EXISTS suggestions (id BIGSERIAL PRIMARY KEY, title TEXT NOT NULL DEFAULT '', text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ DEFAULT NOW())`);
  if (!(await db(`SELECT id FROM settings WHERE id = 1`)).length) await db(`INSERT INTO settings (id) VALUES (1)`);
  const adminPassword = process.env.ADMIN_PASSWORD || "Al-qamir";
  const adminHash = hashPassword(adminPassword);
  const adminRows = await db(`SELECT id FROM users WHERE LOWER(username) = 'admin' LIMIT 1`);
  if (!adminRows.length) {
    await db(`INSERT INTO users (username, email, password_hash, is_admin) VALUES ('Admin', 'admin@qamir.ai', $1, TRUE)`, [adminHash]);
  } else {
    await db(`UPDATE users SET password_hash = $1, is_admin = TRUE WHERE LOWER(username) = 'admin'`, [adminHash]);
  }
}

function bearer(req) { const h = req.headers.authorization || ""; return h.startsWith("Bearer ") ? h.slice(7) : ""; }
async function userFromRequest(req) {
  const token = bearer(req); if (!token) return null;
  const id = Number(token); if (!Number.isSafeInteger(id) || id <= 0) return null;
  const rows = await db(`SELECT id, username, email, birth_date, city, avatar, is_admin, created_at, last_seen FROM users WHERE id = $1 LIMIT 1`, [id]);
  return rows[0] || null;
}
async function requireUser(req, res, next) { try { const user = await userFromRequest(req); if (!user) return res.status(401).json({ error: "Kirish talab qilinadi" }); req.user = user; next(); } catch (e) { console.error("AUTH ERROR:", e); res.status(500).json({ error: "Server xatosi" }); } }
async function requireAdmin(req, res, next) { try { const user = await userFromRequest(req); if (!user || !user.is_admin) return res.status(403).json({ error: "Faqat Admin uchun" }); req.user = user; next(); } catch (e) { console.error("ADMIN ERROR:", e); res.status(500).json({ error: "Server xatosi" }); } }

// ============================================================
// KNOWLEDGE SEARCH
// ============================================================
function normalize(text) { return String(text || "").toLowerCase().replace(/[ʻ’‘`´']/g, "").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim(); }
const STOP_WORDS = new Set(["qanaqa","qanaqib","qanday","qaysi","qayer","qayerda","qayerdan","qayeriga","nima","nega","qilib","qilish","kerak","mumkin","menga","manga","man","men","siz","uchun","bilan","dan","ga","ka","qa","ni","ning","da","de","bo‘yicha","boyicha","shu","bu","bir","bor","yoq","yo‘q","ochaman","ochsam","qilaman","qilay","qilsa","qilsam","ber","berish","olish","olaman","mi","mu","edi","ekan","bo‘ladi","boladi","chi","endi"]);
function stem(word) {
  let w = String(word || ""); if (!w) return "";
  const suffixes = ["laringiz","laring","ingiz","imiz","ning","dan","den","dagi","ga","ka","qa","ni","da","de","lar","lik","li","siz","man","men"];
  for (const suffix of suffixes) if (w.length > suffix.length + 2 && w.endsWith(suffix)) { w = w.slice(0, -suffix.length); break; }
  if (["worddan","word","vord"].includes(w)) return "word";
  if (["eksel","excel"].includes(w)) return "excel";
  if (["powerpoint","ppt"].includes(w)) return "powerpoint";
  if (w === "telegram") return "telegram";
  if (["instagram","insta"].includes(w)) return "instagram";
  if (["telefon","tel"].includes(w)) return "telefon";
  return w;
}
function tokenize(text, options = {}) { const removeStop = options.removeStop !== false; return [...new Set(normalize(text).split(/\s+/).map(stem).filter(w => w.length >= 2).filter(w => !removeStop || !STOP_WORDS.has(w)))]; }
function tokenizeRaw(text) { return [...new Set(normalize(text).split(/\s+/).map(stem).filter(Boolean))]; }
function phraseIncludes(text, phrase) { return ` ${normalize(text)} `.includes(` ${normalize(phrase)} `); }
function overlapCount(queryWords, targetText) {
  const targetWords = tokenizeRaw(targetText), set = new Set(targetWords); let count = 0;
  for (const q of queryWords) { if (set.has(q)) { count++; continue; } if (q.length >= 4 && targetWords.some(t => t === q || t.startsWith(q) || q.startsWith(t))) count++; }
  return count;
}
function extractAlternativeQuestions(rawText) { const m = String(rawText || "").match(/Muqobil\s+savollar\s*:\s*([\s\S]*?)(?=\n\s*Javob\s*:|$)/i); return m ? m[1].split(/[;|]/).map(x => x.trim()).filter(Boolean) : []; }
function levenshtein(a, b) {
  if (a === b) return 0; if (!a.length) return b.length; if (!b.length) return a.length; if (Math.abs(a.length - b.length) > 3) return 99;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i), cur = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) { cur[0] = i; for (let j = 1; j <= b.length; j++) { const cost = a[i-1] === b[j-1] ? 0 : 1; cur[j] = Math.min(cur[j-1] + 1, prev[j] + 1, prev[j-1] + cost); } for (let j = 0; j <= b.length; j++) prev[j] = cur[j]; }
  return prev[b.length];
}
function scoreKnowledge(query, item) {
  const normalizedQuery = normalize(query), qWords = tokenize(query, { removeStop: true }); if (!normalizedQuery || !qWords.length) return 0;
  const question = normalize(item.question || ""), title = normalize(item.title || ""), answer = normalize(item.answer || ""), rawText = normalize(item.raw_text || ""), alternatives = extractAlternativeQuestions(item.raw_text || "");
  let score = 0; if (question && normalizedQuery === question) score += 180;
  for (const alt of alternatives) { const altNorm = normalize(alt); if (normalizedQuery === altNorm) score += 180; else if (phraseIncludes(normalizedQuery, alt) || phraseIncludes(alt, normalizedQuery)) score += 130; }
  const questionHits = overlapCount(qWords, question), titleHits = overlapCount(qWords, title), altHits = alternatives.reduce((best, alt) => Math.max(best, overlapCount(qWords, alt)), 0), strongestHits = Math.max(questionHits, titleHits, altHits), coverage = strongestHits / Math.max(qWords.length, 1);
  score += questionHits * 32 + titleHits * 20 + altHits * 45;
  if (question && (normalizedQuery.includes(question) || question.includes(normalizedQuery))) score += 110;
  if (title && normalizedQuery.includes(title)) score += 80;
  score += Math.min(overlapCount(qWords, answer), 2) * 2 + Math.min(overlapCount(qWords, rawText), 2);
  for (const q of qWords) { if (q.length < 4) continue; const candidates = [question, title, ...alternatives].join(" ").split(/\s+/); if (candidates.some(c => c.length >= 4 && levenshtein(q, c) <= 1)) score += 8; }
  if (qWords.length === 1 && strongestHits === 0) return 0; if (qWords.length >= 2 && coverage < 0.34) return 0; return Math.round(score);
}
async function findKnowledge(query, limit = 8) { const rows = await db(`SELECT id,title,question,answer,raw_text,type,enabled FROM knowledge WHERE enabled = TRUE ORDER BY id DESC`); return rows.map(item => ({ ...item, score: scoreKnowledge(query, item) })).filter(item => item.score >= 55).sort((a,b) => b.score - a.score).slice(0, limit); }
function chooseKnowledgeAnswer(matches) { if (!matches.length) return null; const best = matches[0]; if (best.score >= 120) return best; if (best.score >= 90 && matches.length === 1) return best; if (best.score >= 75) { const second = matches[1]; if (!second || best.score - second.score >= 15) return best; } return null; }

// ============================================================
// DATE / TIME
// ============================================================
function getUzbekistanDateTime() {
  const now = new Date();
  const dateParts = new Intl.DateTimeFormat("uz-UZ", { timeZone: "Asia/Tashkent", year:"numeric", month:"2-digit", day:"2-digit" }).formatToParts(now);
  const timeParts = new Intl.DateTimeFormat("uz-UZ", { timeZone: "Asia/Tashkent", hour:"2-digit", minute:"2-digit", second:"2-digit", hour12:false }).formatToParts(now);
  const weekday = new Intl.DateTimeFormat("uz-UZ", { timeZone: "Asia/Tashkent", weekday:"long" }).format(now);
  const part = (parts, type) => parts.find(x => x.type === type)?.value || "";
  return { year:part(dateParts,"year"), month:part(dateParts,"month"), day:part(dateParts,"day"), hour:part(timeParts,"hour"), minute:part(timeParts,"minute"), second:part(timeParts,"second"), weekday };
}
function getDateTimeAnswer(text) {
  const q = normalize(text), datePatterns = ["bugun nechi","bugun sana","bugungi sana","bugun nechanchi","sana nechi","bugun qaysi kun","bugun nima kun","bugun haftaning qaysi kuni","bugun nechanchi sana"], timePatterns = ["soat nechi","hozir soat nechi","hozirgi vaqt","vaqt nechi","hozir nechi","hozir soat"];
  const asksDate = datePatterns.some(x => q.includes(x)), asksTime = timePatterns.some(x => q.includes(x)); if (!asksDate && !asksTime) return null; const d = getUzbekistanDateTime();
  if (asksTime && !asksDate) return { answer:`Hozir O‘zbekiston vaqti bilan soat ${d.hour}:${d.minute}:${d.second}.`, source:"date_time" };
  if (asksDate && asksTime) return { answer:`Bugun ${d.day}.${d.month}.${d.year}, ${d.weekday}. Hozir soat ${d.hour}:${d.minute}:${d.second}.`, source:"date_time" };
  return { answer:`Bugun ${d.day}.${d.month}.${d.year}, ${d.weekday}.`, source:"date_time" };
}

// ============================================================
// WIKIPEDIA — kengroq savol aniqlash + xavfsiz qidiruv
// ============================================================
function cleanWikipediaQuery(text) {
  return String(text || "")
    .trim()
    .replace(/[?!.]+$/g, "")
    .replace(/\b(?:kim|kimdir|haqida|togrisida|to'g'risida|biografiya|tarjimai holi|who|who is|who was|кто|кто такой|кто такая|биография)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeWikipediaQuestion(text) {
  const q = normalize(text);
  if (!q || q.length < 2) return false;
  if (typeof looksLikeSmartSearchQuestion === "function" && looksLikeSmartSearchQuestion(q)) return false;
  if (looksLikeWeatherQuestion(q) || looksLikeCurrencyQuestion(q) || looksLikeLexUzQuestion(q)) return false;

  const explicit = [
    /\bkim\b/i,/\bkimdir\b/i,/\bhaqida\b/i,/\btogrisida\b/i,/\bbiografiya\b/i,
    /\btarjimai holi\b/i,/\bkim yaratgan\b/i,/\bkim asos solgan\b/i,/\bkim ixtiro qilgan\b/i,
    /\bqachon tugilgan\b/i,/\bqachon vafot etgan\b/i,/\bqayerda tugilgan\b/i,
    /\bpoytaxti\b/i,/\bqaysi davlat\b/i,/\bqaysi mamlakat\b/i,/\bqayerda joylashgan\b/i,
    /\bjoylashgan\b/i,/\bnima bilan mashhur\b/i,/\bwho is\b/i,/\bwho was\b/i,/\bкто\b/i,/\bбиография\b/i
  ];
  if (explicit.some(p => p.test(q))) return true;

  if (/[?]$/.test(String(text || "").trim())) {
    const qWords = tokenizeRaw(q);
    const qs = new Set(["nima","qaysi","qayer","qayerda","qachon","kim","qanday","poytaxti","davlat","shahar","daryo","tog","orol","sayyora","tarix"]);
    return qWords.length >= 2 && qWords.length <= 10 && qWords.some(w => qs.has(w));
  }
  return false;
}

function cleanWikipediaHtml(text) {
  return String(text || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<span[^>]*>/gi, "")
    .replace(/<\/span>/gi, "")
    .replace(/<[^>]*>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#160;/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n\s+/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function scoreWikipediaTitle(query, title) {
  const qWords = tokenizeRaw(query).filter(w => w.length >= 2);
  const tWords = tokenizeRaw(title).filter(w => w.length >= 2);
  if (!qWords.length || !tWords.length) return 0;

  let score = 0;
  let matched = 0;
  for (const qw of qWords) {
    let best = 0;
    for (const tw of tWords) {
      if (qw === tw) best = Math.max(best, 110);
      else if (qw.length >= 4 && tw.length >= 4 && (qw.startsWith(tw) || tw.startsWith(qw))) best = Math.max(best, 80);
      else {
        const d = levenshtein(qw, tw);
        if (d === 1) best = Math.max(best, 65);
        else if (d === 2 && qw.length >= 5 && tw.length >= 5) best = Math.max(best, 45);
      }
    }
    if (best) { matched++; score += best; }
  }

  score += (matched / Math.max(qWords.length, 1)) * 100;
  if (normalize(title) === normalize(query)) score += 300;
  if (qWords.length >= 2 && matched >= 2) score += 50;
  return score;
}

async function wikipediaSearchRaw(language, query, limit = 10) {
  const base = `https://${language}.wikipedia.org`;
  const url = `${base}/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srnamespace=0&srlimit=${Math.min(50, Math.max(1, limit))}&srprop=snippet|titlesnippet|sectiontitle|categorysnippet&format=json&formatversion=2&origin=*`;

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": "QamirAI/1.0 (Qamir AI personal assistant; contact: admin@qamir.ai)",
        "Api-User-Agent": "QamirAI/1.0 (Qamir AI personal assistant)"
      },
      signal: AbortSignal.timeout(12000)
    });

    if (!response.ok) return { pages: [], suggestion: "" };
    const data = await response.json().catch(() => ({}));
    const pages = Array.isArray(data?.query?.search)
      ? data.query.search.map(item => ({
          title: String(item?.title || "").trim(),
          pageid: item?.pageid || null,
          snippet: cleanWikipediaHtml(item?.snippet || "")
        }))
      : [];

    return {
      pages,
      suggestion: String(data?.query?.searchinfo?.suggestion || "").trim()
    };
  } catch (e) {
    console.error(`Wikipedia ${language} SEARCH ERROR:`, e.message);
    return { pages: [], suggestion: "" };
  }
}

async function wikipediaGetPage(language, title) {
  const base = `https://${language}.wikipedia.org`;

  try {
    const url = `${base}/w/api.php?action=query&prop=extracts|info&exintro=1&explaintext=1&exchars=5000&inprop=url&redirects=1&titles=${encodeURIComponent(title)}&format=json&formatversion=2&origin=*`;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": "QamirAI/1.0 (Qamir AI personal assistant; contact: admin@qamir.ai)",
        "Api-User-Agent": "QamirAI/1.0 (Qamir AI personal assistant)"
      },
      signal: AbortSignal.timeout(12000)
    });

    if (response.ok) {
      const data = await response.json().catch(() => ({}));
      const page = Array.isArray(data?.query?.pages) ? data.query.pages[0] : null;
      if (page && !page.missing) {
        const extract = cleanWikipediaHtml(page.extract || "");
        if (extract) {
          return {
            title: String(page.title || title).trim(),
            extract,
            url: String(page.fullurl || "").trim()
          };
        }
      }
    }
  } catch (e) {
    console.error(`Wikipedia page ${language} API ERROR:`, e.message);
  }

  try {
    const summaryUrl = `${base}/api/rest_v1/page/summary/${encodeURIComponent(String(title || "").replace(/ /g, "_"))}`;
    const response = await fetch(summaryUrl, {
      method: "GET",
      headers: {
        "Accept": "application/json",
        "User-Agent": "QamirAI/1.0 (Qamir AI personal assistant)"
      },
      signal: AbortSignal.timeout(12000)
    });

    if (!response.ok) return null;
    const data = await response.json().catch(() => ({}));
    const extract = cleanWikipediaHtml(data?.extract || data?.description || "");
    if (!extract) return null;

    return {
      title: String(data?.title || title).trim(),
      extract,
      url: String(data?.content_urls?.desktop?.page || "").trim()
    };
  } catch (e) {
    console.error(`Wikipedia ${language} REST ERROR:`, e.message);
    return null;
  }
}

function makeWikipediaVariants(query, suggestion = "") {
  const variants = [];
  const seen = new Set();
  const add = value => {
    const v = String(value || "").trim().replace(/\s+/g, " ");
    const key = normalize(v);
    if (!v || v.length < 2 || !key || seen.has(key)) return;
    seen.add(key);
    variants.push(v);
  };

  add(query);
  add(suggestion);
  add(cleanWikipediaQuery(query));

  const words = tokenizeRaw(cleanWikipediaQuery(query)).filter(w => w.length >= 3);
  if (words.length > 1) add(words.join(" "));
  for (const word of words) add(word);

  return variants.slice(0, 10);
}

async function fetchWikipediaFromLanguage(language, query) {
  try {
    const first = await wikipediaSearchRaw(language, query, 12);
    let allPages = [...(first.pages || [])];

    for (const variant of makeWikipediaVariants(query, first.suggestion).slice(0, 6)) {
      if (normalize(variant) === normalize(query)) continue;
      const result = await wikipediaSearchRaw(language, variant, 8);
      allPages.push(...(result.pages || []));
    }

    const unique = [];
    const seen = new Set();
    for (const item of allPages) {
      const title = String(item?.title || "").trim();
      const key = normalize(title);
      if (!title || !key || seen.has(key)) continue;
      seen.add(key);
      unique.push(item);
    }

    if (!unique.length) return null;

    const qNorm = normalize(query);
    let bestPage = null;
    let bestScore = -1;

    for (const candidate of unique) {
      const title = String(candidate?.title || "").trim();
      const snippet = normalize(candidate?.snippet || "");
      let score = scoreWikipediaTitle(query, title);
      const titleNorm = normalize(title);
      if (titleNorm === qNorm) score += 400;
      if (titleNorm.includes(qNorm) || qNorm.includes(titleNorm)) score += 130;
      for (const word of tokenizeRaw(query).filter(w => w.length >= 4)) {
        if (snippet.includes(word)) score += 12;
      }
      if (score > bestScore) {
        bestScore = score;
        bestPage = candidate;
      }
    }

    if (!bestPage || bestScore < 100) return null;

    const page = await wikipediaGetPage(language, bestPage.title);
    if (!page) return null;

    return {
      language,
      title: page.title,
      description: "",
      extract: page.extract,
      url: page.url
    };
  } catch (e) {
    console.error(`WIKIPEDIA ${language.toUpperCase()} ERROR:`, e.message);
    return null;
  }
}

async function searchWikipedia(userText) {
  if (!looksLikeWikipediaQuestion(userText)) return null;
  const query = cleanWikipediaQuery(userText);
  if (!query || query.length < 2) return null;

  for (const language of ["uz", "en", "ru"]) {
    const result = await fetchWikipediaFromLanguage(language, query);
    if (result) return result;
  }

  return null;
}

// ============================================================
// OB-HAVO - OPEN-METEO
// API KEY TALAB QILMAYDI
// O'ZBEKISTON SHAHARLARI UCHUN
// ============================================================

const OPEN_METEO_GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search";
const OPEN_METEO_FORECAST_URL = "https://api.open-meteo.com/v1/forecast";

function weatherCodeUzbek(code) {
  const map = {
    0: "Ochiq osmon", 1: "Asosan ochiq", 2: "Qisman bulutli", 3: "Bulutli",
    45: "Tuman", 48: "Qirovli tuman", 51: "Yengil maydalab yomg‘ir",
    53: "O‘rtacha maydalab yomg‘ir", 55: "Kuchli maydalab yomg‘ir",
    56: "Yengil muzli maydalab yomg‘ir", 57: "Kuchli muzli maydalab yomg‘ir",
    61: "Yengil yomg‘ir", 63: "O‘rtacha yomg‘ir", 65: "Kuchli yomg‘ir",
    66: "Yengil muzli yomg‘ir", 67: "Kuchli muzli yomg‘ir", 71: "Yengil qor",
    73: "O‘rtacha qor", 75: "Kuchli qor", 77: "Qor donachalari",
    80: "Yengil jala", 81: "O‘rtacha jala", 82: "Kuchli jala",
    85: "Yengil qorli jala", 86: "Kuchli qorli jala", 95: "Momaqaldiroq",
    96: "Do‘l bilan momaqaldiroq", 99: "Kuchli do‘l bilan momaqaldiroq"
  };
  return map[Number(code)] || "Ob-havo noma’lum";
}

function weatherWeekdayUz(dateString) {
  try {
    return new Intl.DateTimeFormat("uz-UZ", {
      timeZone: "Asia/Tashkent", weekday: "long", day: "2-digit", month: "2-digit"
    }).format(new Date(`${dateString}T12:00:00`));
  } catch { return dateString; }
}

function looksLikeWeatherQuestion(text) {
  const q = normalize(text);
  if (!q || q.length < 2) return false;
  const patterns = [
    "ob havo", "obxavo", "havo qanday", "havo qanaqa", "harorat", "temperatura",
    "gradus", "yomgir yogadimi", "qor yogadimi", "bugun havo", "bugungi ob havo",
    "ertaga havo", "ertangi ob havo", "ob havoni korsat", "ob havoni ayt",
    "ob havo malumot", "pogoda", "погода", "температура", "weather"
  ];
  return patterns.some(pattern => q.includes(pattern));
}

function cleanWeatherCity(text) {
  return String(text || "")
    .trim()
    .replace(/[?!.,:;]+/g, " ")
    .replace(/[\-–—]+/g, " ")
    .replace(/\b(?:ob\s+havo|obxavo|havo|pogoda|weather|temperatura|harorat)\b/giu, " ")
    .replace(/\b(?:bugun|bugungi|bugungi\s+kuni|ertaga|ertangi|hozir|hozirgi)\b/giu, " ")
    .replace(/\b(?:qanday|qanaqa|nechi|necha|gradus|yogadimi|yog‘adimi)\b/giu, " ")
    .replace(/\b(?:korsat|ko'rsat|ayt|ber|bilmoqchiman)\b/giu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function geocodeUzbekistanCity(cityName) {
  const city = String(cityName || "").trim();
  if (!city) return null;
  const url = `${OPEN_METEO_GEOCODING_URL}?name=${encodeURIComponent(city)}&count=10&language=uz&format=json&countryCode=UZ`;
  const response = await fetch(url, {
    method: "GET", headers: { "Accept": "application/json", "User-Agent": "QamirAI/1.0" },
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error(`Open-Meteo geocoding HTTP ${response.status}`);
  const data = await response.json().catch(() => ({}));
  const results = Array.isArray(data?.results) ? data.results : [];
  return results[0] || null;
}

async function getOpenMeteoWeather(latitude, longitude) {
  const params = new URLSearchParams({
    latitude: String(latitude), longitude: String(longitude),
    current: "temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,rain,weather_code,cloud_cover,wind_speed_10m",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,rain_sum,wind_speed_10m_max,sunrise,sunset",
    timezone: "auto", forecast_days: "3", temperature_unit: "celsius", wind_speed_unit: "kmh", precipitation_unit: "mm"
  });
  const response = await fetch(`${OPEN_METEO_FORECAST_URL}?${params.toString()}`, {
    method: "GET", headers: { "Accept": "application/json", "User-Agent": "QamirAI/1.0" },
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Open-Meteo weather HTTP ${response.status}: ${body.slice(0, 300)}`);
  }
  const data = await response.json().catch(() => ({}));
  if (!data?.current || !data?.daily) throw new Error("Open-Meteo ob-havo ma’lumoti kelmadi.");
  return data;
}

async function getWeatherAnswer(text, userCity = "") {
  if (!looksLikeWeatherQuestion(text)) return null;
  let city = cleanWeatherCity(text).replace(/(?:da|ta|ga|ka)$/iu, "").trim();
  if (!city) city = String(userCity || "").trim();
  if (!city) city = "Toshkent";

  let location = await geocodeUzbekistanCity(city);
  if (!location) {
    const fallbackCity = city.replace(/\b(?:shahri|shahar|viloyati|viloyat)\b/giu, " ").replace(/\s+/g, " ").trim();
    if (fallbackCity && fallbackCity.toLowerCase() !== city.toLowerCase()) {
      location = await geocodeUzbekistanCity(fallbackCity);
    }
  }
  if (!location) {
    return {
      answer: `“${city}” bo‘yicha O‘zbekistonda ob-havo ma’lumoti topilmadi. Masalan: “Toshkentda ob-havo qanday?” deb yozing.`,
      source: "weather_error"
    };
  }

  const weather = await getOpenMeteoWeather(location.latitude, location.longitude);
  const current = weather.current;
  const daily = weather.daily;
  const lines = [];

  lines.push(`🌦 ${location.name}, ${location.country || "O‘zbekiston"}`);
  lines.push(`Hozir: ${Number(current.temperature_2m)}°C`);
  lines.push(`Holat: ${weatherCodeUzbek(current.weather_code)}`);
  lines.push(`His qilinishi: ${Number(current.apparent_temperature)}°C`);
  lines.push(`Namlik: ${Number(current.relative_humidity_2m)}%`);
  lines.push(`Shamol: ${Number(current.wind_speed_10m)} km/soat`);
  if (Number(current.precipitation || 0) > 0) lines.push(`Yog‘ingarchilik: ${Number(current.precipitation)} mm`);

  lines.push("");
  lines.push("📅 Keyingi 3 kun:");
  const dailyTime = Array.isArray(daily.time) ? daily.time : [];
  for (let i = 0; i < dailyTime.length; i++) {
    const date = dailyTime[i];
    const max = Number(daily.temperature_2m_max?.[i] ?? 0);
    const min = Number(daily.temperature_2m_min?.[i] ?? 0);
    const rainProbability = Number(daily.precipitation_probability_max?.[i] ?? 0);
    const dailyRain = Number(daily.rain_sum?.[i] ?? 0);
    const dailyCode = Number(daily.weather_code?.[i] ?? 0);
    lines.push(`${weatherWeekdayUz(date)} — ${weatherCodeUzbek(dailyCode)}, ${min}°C / ${max}°C, yomg‘ir ehtimoli ${rainProbability}%`);
    if (dailyRain > 0) lines.push(`  Yog‘in miqdori: ${dailyRain} mm`);
  }
  lines.push("");
  lines.push("Manba: Open-Meteo");

  return { answer: lines.join("\n"), source: "weather", city: location.name, latitude: location.latitude, longitude: location.longitude };
}

// ============================================================
// END OB-HAVO
// ============================================================

// ============================================================
// VALYUTA KURSLARI - O'ZBEKISTON MARKAZIY BANKI
// API KEY TALAB QILMAYDI
// ============================================================

const CBU_CURRENCY_URL =
  "https://cbu.uz/uz/arkhiv-kursov-valyut/json/";

const CURRENCY_ALIASES = {
  USD: [
    "usd", "dollar", "dollor", "dolar", "dollari",
    "aqsh dollari", "amerikan dollari", "amerika dollari"
  ],
  EUR: [
    "eur", "euro", "evro", "yevرو", "evroni", "evrosi"
  ],
  RUB: [
    "rub", "rubl", "rublь", "rubl", "rossiya rubli", "rossiya rubli"
  ],
  GBP: [
    "gbp", "funt", "funt sterling", "ingliz funti", "angliya funti"
  ],
  CNY: [
    "cny", "yuan", "yuань", "xitoy yuani", "xitoy yuani"
  ],
  JPY: [
    "jpy", "iyena", "iena", "yapon iyenasi", "yapon ienası"
  ],
  KZT: [
    "kzt", "tenge", "qozog'iston tengesi", "qozogiston tengesi"
  ],
  TRY: [
    "try", "lira", "turk lirasi", "turkiya lirasi"
  ]
};

function normalizeCurrencyText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[ʻ’‘`´]/g, "'")
    .replace(/[?!.(),;:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeCurrencyQuestion(text) {
  const q = normalizeCurrencyText(text);

  if (!q) return false;

  const keywords = [
    "valyuta", "valyutalar", "kurs", "kursi", "kurslar",
    "dollar", "dollor", "dolar", "evro", "euro", "rubl",
    "rublь", "funt", "yuan", "iyena", "iena", "tenge", "lira",
    "usd", "eur", "rub", "gbp", "cny", "jpy", "kzt", "try",
    "sum", "so'm", "som", "so'mda", "somda"
  ];

  return keywords.some(keyword =>
    q.includes(keyword)
  );
}

function findCurrencyCode(text) {
  const q = normalizeCurrencyText(text);

  const entries = Object.entries(CURRENCY_ALIASES)
    .sort((a, b) => {
      const maxA = Math.max(...a[1].map(x => x.length));
      const maxB = Math.max(...b[1].map(x => x.length));
      return maxB - maxA;
    });

  for (const [code, aliases] of entries) {
    for (const alias of aliases) {
      if (q.includes(alias)) {
        return code;
      }
    }
  }

  return null;
}

function extractCurrencyAmount(text) {
  const q = normalizeCurrencyText(text);

  const patterns = [
    /(?:^|\s)(\d+(?:[.,]\d+)?)\s*(?:ming|mingta)?\s*(?:usd|dollar|dollor|dolar|eur|euro|evro|rub|rubl|gbp|funt|cny|yuan|jpy|iyena|iena|kzt|tenge|try|lira)(?:\s|$)/i,
    /(?:\b)(\d+(?:[.,]\d+)?)(?:\s+)(?:ta\s+)?(?:usd|dollar|dollor|dolar|eur|euro|evro|rub|rubl|gbp|funt|cny|yuan|jpy|iyena|iena|kzt|tenge|try|lira)(?:\b)/i,
    /(?:\b)(?:usd|dollar|dollor|dolar|eur|euro|evro|rub|rubl|gbp|funt|cny|yuan|jpy|iyena|iena|kzt|tenge|try|lira)(?:\s*)(\d+(?:[.,]\d+)?)(?:\b)/i
  ];

  for (const pattern of patterns) {
    const m = q.match(pattern);
    if (m) {
      const amount = Number(String(m[1]).replace(",", "."));
      if (Number.isFinite(amount) && amount > 0 && amount <= 1000000000) {
        return amount;
      }
    }
  }

  return null;
}

function formatCurrencyNumber(value) {
  return Number(value).toLocaleString("uz-UZ", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    useGrouping: true
  });
}

async function getCbuCurrencies() {
  const response = await fetch(CBU_CURRENCY_URL, {
    method: "GET",
    headers: {
      "Accept": "application/json",
      "User-Agent": "QamirAI/1.0"
    },
    signal: AbortSignal.timeout(12000)
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `CBU currency HTTP ${response.status}: ${body.slice(0, 300)}`
    );
  }

  const data = await response.json().catch(() => null);

  if (!Array.isArray(data) || !data.length) {
    throw new Error(
      "Markaziy bankdan valyuta kurslari kelmadi."
    );
  }

  return data;
}

function getCurrencyRow(rows, code) {
  return rows.find(
    row =>
      String(row?.Ccy || row?.ccy || "").toUpperCase() === code
  ) || null;
}

function formatCurrencyRow(row) {
  const code = String(row?.Ccy || "").toUpperCase();
  const name = String(row?.CcyNm_UZ || row?.CcyNm_EN || code).trim();
  const nominal = Number(row?.Nominal || 1);
  const rate = Number(String(row?.Rate || "0").replace(",", "."));
  const diff = Number(String(row?.Diff || "0").replace(",", "."));

  return {
    code,
    name,
    nominal: Number.isFinite(nominal) && nominal > 0 ? nominal : 1,
    rate,
    diff: Number.isFinite(diff) ? diff : 0,
    date: String(row?.Date || "").trim()
  };
}

async function getCurrencyAnswer(text) {
  if (!looksLikeCurrencyQuestion(text)) {
    return null;
  }

  const code = findCurrencyCode(text);
  const amount = extractCurrencyAmount(text);
  const rows = await getCbuCurrencies();

  const commonCodes = ["USD", "EUR", "RUB", "GBP", "CNY", "JPY", "KZT", "TRY"];

  if (code) {
    const row = getCurrencyRow(rows, code);

    if (!row) {
      return {
        answer:
          `${code} bo‘yicha Markaziy bank kursi hozircha topilmadi.`,
        source: "currency_error"
      };
    }

    const c = formatCurrencyRow(row);
    const lines = [
      `💱 ${c.name} (${c.code})`,
      `Kurs: ${c.nominal} ${c.code} = ${formatCurrencyNumber(c.rate)} so‘m`,
      `O‘zgarish: ${c.diff >= 0 ? "+" : ""}${formatCurrencyNumber(c.diff)} so‘m`,
      `Sana: ${c.date || "noma’lum"}`
    ];

    if (amount != null) {
      const sumAmount = amount * (c.rate / c.nominal);
      lines.push(`Hisob: ${formatCurrencyNumber(amount)} ${c.code} ≈ ${formatCurrencyNumber(sumAmount)} so‘m`);
    }

    lines.push("Manba: O‘zbekiston Respublikasi Markaziy banki");

    return {
      answer: lines.join("\n"),
      source: "currency_cbu",
      currency: c.code,
      amount: amount ?? null,
      sum: amount != null ? amount * (c.rate / c.nominal) : null,
      date: c.date
    };
  }

  const selected = [];

  for (const item of commonCodes) {
    const row = getCurrencyRow(rows, item);
    if (row) selected.push(formatCurrencyRow(row));
  }

  if (!selected.length) {
    return {
      answer: "Markaziy bankdan valyuta kurslari topilmadi.",
      source: "currency_error"
    };
  }

  const date = selected.find(x => x.date)?.date || "";
  const lines = [
    `💱 O‘zbekiston Respublikasi Markaziy banki valyuta kurslari${date ? ` — ${date}` : ""}`,
    ""
  ];

  for (const c of selected) {
    lines.push(
      `${c.code} — ${c.name}: ${c.nominal} ${c.code} = ${formatCurrencyNumber(c.rate)} so‘m (${c.diff >= 0 ? "+" : ""}${formatCurrencyNumber(c.diff)})`
    );
  }

  lines.push("");
  lines.push("Manba: O‘zbekiston Respublikasi Markaziy banki");

  return {
    answer: lines.join("\n"),
    source: "currency_cbu",
    date
  };
}

// ============================================================
// END VALYUTA KURSLARI
// ============================================================

// ============================================================
// WIKIDATA — API KEY TALAB QILMAYDI
// Faqat juda ishonchli entity mosligi uchun ishlatiladi.
// ============================================================
const WIKIDATA_API_URL = "https://www.wikidata.org/w/api.php";

function normalizeWikidataText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[ʻ’‘`´']/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeWikidataQuestion(text) {
  const q = normalizeWikidataText(text);
  if (!q || q.length < 2) return false;
  if (typeof looksLikeSmartSearchQuestion === "function" && looksLikeSmartSearchQuestion(q)) return false;
  if (looksLikeLexUzQuestion(q) || looksLikeWeatherQuestion(q) || looksLikeCurrencyQuestion(q)) return false;
  return [
    /\bkim\b/i,/\bkimdir\b/i,/\bhaqida\b/i,/\bbiografiya\b/i,
    /\btugilgan\b/i,/\bvafot etgan\b/i,/\bmillati\b/i,/\bfuqaroligi\b/i,
    /\bkasbi\b/i,/\blavozimi\b/i,/\bpoytaxti\b/i,/\bqayerda joylashgan\b/i
  ].some(p => p.test(q));
}

function cleanWikidataValue(text){return String(text||"").replace(/\s+/g," ").trim();}
function getWikidataLabel(entity,language="uz"){return cleanWikidataValue(entity?.labels?.[language]?.value||entity?.labels?.en?.value||entity?.labels?.ru?.value||"");}
function getWikidataDescription(entity,language="uz"){return cleanWikidataValue(entity?.descriptions?.[language]?.value||entity?.descriptions?.en?.value||entity?.descriptions?.ru?.value||"");}
function getWikidataAliases(entity,language="uz"){const out=[];for(const lang of [language,"en","ru"]){for(const a of entity?.aliases?.[lang]||[]){const v=cleanWikidataValue(a?.value||"");if(v&&!out.includes(v))out.push(v);}}return out.slice(0,10);}
function wikidataTimeToUzbek(value){const m=String(value||"").match(/^[+-]?(\d{1,6})-(\d{2})-(\d{2})/);return m?`${m[3]}.${m[2]}.${m[1]}`:"";}
function getWikidataClaimEntityIds(entity,property){const claims=entity?.claims?.[property];if(!Array.isArray(claims))return[];const out=[];for(const c of claims.slice(0,8)){const id=c?.mainsnak?.datavalue?.value?.id;if(typeof id==='string'&&/^Q\d+$/i.test(id)&&!out.includes(id))out.push(id);}return out;}
function getWikidataClaimTime(entity,property){const claims=entity?.claims?.[property];if(!Array.isArray(claims))return"";for(const c of claims.slice(0,8)){const t=c?.mainsnak?.datavalue?.value?.time;if(t)return wikidataTimeToUzbek(t);}return"";}

async function wikidataApiRequest(params){
  const query=new URLSearchParams({...params,format:"json",formatversion:"2",origin:"*"});
  const response=await fetch(`${WIKIDATA_API_URL}?${query.toString()}`,{method:"GET",headers:{Accept:"application/json","User-Agent":"QamirAI/1.0 (Qamir AI personal assistant; contact: admin@qamir.ai)"},signal:AbortSignal.timeout(12000)});
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(`Wikidata HTTP ${response.status}`);
  if(data?.error)throw new Error(data.error.info||"Wikidata API xatosi");
  return data;
}
async function wikidataSearchEntities(language,query,limit=8){const data=await wikidataApiRequest({action:"wbsearchentities",search:query,language,uselang:language,type:"item",limit:String(Math.min(20,Math.max(1,limit)))});return Array.isArray(data?.search)?data.search:[];}
async function wikidataGetEntities(ids){if(!ids.length)return{};const data=await wikidataApiRequest({action:"wbgetentities",ids:ids.slice(0,20).join("|"),props:"labels|descriptions|aliases|claims",languages:"uz|en|ru"});return data?.entities||{};}

function wikidataCandidateScore(query,item){
  const q=normalizeWikidataText(query),label=normalizeWikidataText(item?.label||""),aliases=(item?.aliases||[]).map(normalizeWikidataText).filter(Boolean);
  if(!q||!label)return{score:0,matched:0};
  if(q===label)return{score:1000,matched:q.split(/\s+/).length};
  let score=0,matched=0;
  const qWords=q.split(/\s+/).filter(Boolean),lWords=label.split(/\s+/).filter(Boolean);
  for(const qw of qWords){let best=0;for(const lw of lWords){if(qw===lw)best=Math.max(best,150);else if(qw.length>=4&&lw.length>=4&&(qw.startsWith(lw)||lw.startsWith(qw)))best=Math.max(best,95);else if(levenshtein(qw,lw)<=1)best=Math.max(best,65);}if(best){matched++;score+=best;}}
  for(const a of aliases){if(q===a)score+=350;else if(a.includes(q)||q.includes(a))score+=120;}
  score+=(matched/Math.max(qWords.length,1))*150;
  return{score,matched};
}

async function searchWikidata(userText){
  if(!looksLikeWikidataQuestion(userText))return null;
  const query=String(userText||"").trim().replace(/[?!.]+$/g,"").replace(/\b(?:kim|kimdir|haqida|biografiya|tarjimai holi|qachon tugilgan|qayerda tugilgan|vafot etgan|millati|fuqaroligi|kasbi|lavozimi|poytaxti|qayerda joylashgan)\b/gi," ").replace(/\s+/g," ").trim();
  if(!query||query.length<2)return null;

  const all=[];
  for(const language of ["uz","en","ru"]){
    try{for(const item of await wikidataSearchEntities(language,query,8))all.push({...item,searchLanguage:language});}
    catch(e){console.error(`WIKIDATA SEARCH ${language.toUpperCase()} ERROR:`,e.message);}
  }
  if(!all.length)return null;

  const unique=[],seen=new Set();
  for(const item of all){const id=String(item?.id||"").trim();if(!/^Q\d+$/i.test(id)||seen.has(id))continue;seen.add(id);unique.push(item);}
  unique.sort((a,b)=>wikidataCandidateScore(query,b).score-wikidataCandidateScore(query,a).score);
  const best=unique[0];if(!best)return null;
  const scored=wikidataCandidateScore(query,best),qCount=query.split(/\s+/).filter(Boolean).length;
  if(scored.score<220||(qCount>=2&&scored.matched<Math.min(2,qCount))){console.log(`Wikidata: ishonchli entity topilmadi. query=${query} score=${scored.score} matched=${scored.matched}`);return null;}

  let entities={};
  try{entities=await wikidataGetEntities([best.id]);}catch(e){console.error("WIKIDATA ENTITY ERROR:",e.message);return null;}
  const entity=entities?.[best.id];if(!entity)return null;

  const label=getWikidataLabel(entity,"uz")||getWikidataLabel(entity,"en")||String(best.label||query);
  const description=getWikidataDescription(entity,"uz")||getWikidataDescription(entity,"en")||String(best.description||"");
  const finalScore=wikidataCandidateScore(query,{label,aliases:getWikidataAliases(entity,"uz")}).score;
  if(finalScore<220){console.log(`Wikidata final validation failed: ${label} score=${finalScore}`);return null;}

  const birthDate=getWikidataClaimTime(entity,"P569"),deathDate=getWikidataClaimTime(entity,"P570");
  const occupationIds=getWikidataClaimEntityIds(entity,"P106"),citizenshipIds=getWikidataClaimEntityIds(entity,"P27"),positionIds=getWikidataClaimEntityIds(entity,"P39"),capitalIds=getWikidataClaimEntityIds(entity,"P36");
  const relatedIds=[...new Set([...occupationIds,...citizenshipIds,...positionIds,...capitalIds])].slice(0,12);
  const related=relatedIds.length?await wikidataGetEntities(relatedIds).catch(()=>({})):{};
  const labels=ids=>ids.map(id=>getWikidataLabel(related?.[id],"uz")||getWikidataLabel(related?.[id],"en")).filter(Boolean);

  const lines=[`📚 ${label}`];
  if(description)lines.push(`Tavsif: ${description}`);
  if(birthDate)lines.push(`Tug‘ilgan: ${birthDate}`);
  if(deathDate)lines.push(`Vafot etgan: ${deathDate}`);
  const occupations=labels(occupationIds).slice(0,3);if(occupations.length)lines.push(`Kasbi: ${occupations.join(", ")}`);
  const positions=labels(positionIds).slice(0,3);if(positions.length)lines.push(`Lavozimi: ${positions.join(", ")}`);
  const citizenships=labels(citizenshipIds).slice(0,3);if(citizenships.length)lines.push(`Fuqaroligi: ${citizenships.join(", ")}`);
  const capitals=labels(capitalIds).slice(0,2);if(capitals.length)lines.push(`Poytaxti: ${capitals.join(", ")}`);
  return{answer:lines.join("\n"),source:"wikidata",title:label,description,birth_date:birthDate||null,death_date:deathDate||null};
}

// ============================================================
// END WIKIDATA
// ============================================================


// ============================================================

// ============================================================
// LEXUZ — O'ZBEKISTON QONUNCHILIK MA'LUMOTLARI MILLIY BAZASI
// Ochiq LexUZ sahifalaridan foydalanadi; alohida API key talab qilmaydi.
// ============================================================
const LEXUZ_BASE_URL = "https://lex.uz";

function normalizeLexUzText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[ʻ’‘`´]/g, "'")
    .replace(/[^\p{L}\p{N}\s\-№]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeLexUzQuestion(text) {
  const q = normalizeLexUzText(text);
  if (!q) return false;
  if (typeof looksLikeSmartSearchQuestion === "function" && looksLikeSmartSearchQuestion(q)) return false;
  return [
    /\bmodda\b/i,/\bmoddasiga\b/i,/\bmoddasida\b/i,
    /\bkonstitutsiya\b/i,/\bkodeks\b/i,/\bqonun\b/i,/\bqonunchilik\b/i,
    /\bfarmon\b/i,/\bqaror\b/i,/\bfarmoyish\b/i,/\bO['’]?RQ[- ]?\d+/i,
    /\bPQ[- ]?\d+/i,/\bPF[- ]?\d+/i,/\blexuz\b/i,/\bhuquq\b/i,
    /\bhuquqlari\b/i,/\bmajburiyat\b/i,/\bjavobgarlik\b/i
  ].some(p => p.test(q));
}

function cleanLexUzQuery(text) {
  return String(text || "")
    .trim()
    .replace(/[?!.]+$/g, "")
    .replace(/\b(?:lexuz|lex\.uz|modda|moddasi|moddasini|nima|qanday|qaysi|belgilangan)\b/giu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractLexUzArticleNumber(text) {
  const m = String(text || "").match(/(?:^|\s)(\d{1,4})\s*[-–—]?\s*modda\b/i);
  return m ? Number(m[1]) : null;
}

function lexUzHtmlToText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>(?:\r?\n)?/gi, "\n")
    .replace(/<\/p>|<\/div>|<\/li>|<\/tr>|<\/h[1-6]>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&ndash;/gi, "–")
    .replace(/&mdash;/gi, "—")
    .replace(/&#39;|&#039;|&#x27;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeLexHref(href) {
  const v = String(href || "").trim();
  if (!v) return "";
  if (/^https?:\/\//i.test(v)) return v;
  return `${LEXUZ_BASE_URL}${v.startsWith("/") ? "" : "/"}${v}`;
}

async function lexUzFetch(url) {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
      "Accept-Language": "uz,ru;q=0.8,en;q=0.6",
      "User-Agent": "QamirAI/1.0 (Qamir AI personal assistant; contact: admin@qamir.ai)"
    },
    signal: AbortSignal.timeout(15000)
  });
  const body = await response.text().catch(() => "");
  if (!response.ok) throw new Error(`LexUZ HTTP ${response.status}: ${body.slice(0, 200)}`);
  return body;
}

function parseLexUzSearchResults(html) {
  const results = [];
  const seen = new Set();
  const re = /<a\b[^>]*href=["']([^"']*\/uz\/docs\/-?\d+[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html || "")))) {
    const href = normalizeLexHref(m[1]);
    const title = lexUzHtmlToText(m[2]).replace(/\s+/g, " ").trim();
    const key = href.toLowerCase();
    if (!href || !title || title.length < 4 || seen.has(key)) continue;
    seen.add(key);
    results.push({ title, url: href });
    if (results.length >= 15) break;
  }
  return results;
}

function scoreLexUzResult(query, item) {
  const qWords = tokenizeRaw(query).filter(w => w.length >= 2);
  const title = normalizeLexUzText(item?.title || "");
  const tWords = title.split(/\s+/).filter(Boolean);
  if (!qWords.length || !tWords.length) return 0;

  let score = 0, matched = 0;
  const qNorm = normalizeLexUzText(query);
  if (title === qNorm) score += 500;
  if (title.includes(qNorm) || qNorm.includes(title)) score += 180;

  for (const q of qWords) {
    let best = 0;
    for (const t of tWords) {
      if (q === t) best = Math.max(best, 100);
      else if (q.length >= 4 && t.length >= 4 && (q.startsWith(t) || t.startsWith(q))) best = Math.max(best, 65);
      else if (levenshtein(q, t) <= 1) best = Math.max(best, 45);
    }
    if (best) { matched++; score += best; }
  }

  return score + (matched / Math.max(qWords.length, 1)) * 100;
}

function extractLexUzArticle(text, articleNumber) {
  if (!articleNumber) return "";
  const plain = String(text || "");

  const re = new RegExp(
    `(?:^|\\n|\\s)${articleNumber}\\s*-?\\s*modda\\b[\\s:.-]*`,
    "i"
  );

  const match = plain.match(re);
  if (!match || match.index == null) return "";

  const start = match.index;
  const after = plain.slice(start);
  const next = after.search(/(?:\n|\s+)\d{1,4}\s*-?\s*modda\b/i);
  const chunk = (next > 0 ? after.slice(0, next) : after).trim();

  return chunk.slice(0, 6000).trim();
}


async function searchLexUz(userText) {
  if (!looksLikeLexUzQuestion(userText)) return null;

  const articleNumber = extractLexUzArticleNumber(userText);
  const original = String(userText || "").trim();
  const cleaned = cleanLexUzQuery(original);
  const queries = [];

  const addQuery = q => {
    const v = String(q || "").replace(/\s+/g, " ").trim();
    if (!v || queries.some(x => normalizeLexUzText(x) === normalizeLexUzText(v))) return;
    queries.push(v);
  };

  addQuery(original.replace(/[?!.]+$/g, ""));
  if (articleNumber) {
    addQuery(`O'zbekiston Respublikasi Konstitutsiyasi ${articleNumber}-modda`);
    addQuery(`Konstitutsiya ${articleNumber}-modda`);
  }
  addQuery(cleaned);
  if (/konstitutsiya/i.test(original) || articleNumber) addQuery("O'zbekiston Respublikasi Konstitutsiyasi");

  // Konstitutsiya uchun to'g'ridan-to'g'ri amaldagi LexUZ hujjati:
  // https://lex.uz/docs/-6445145
  // Bu qidiruv sahifasi o'zgarib qolsa ham Konstitutsiya moddalarini olishga imkon beradi.
  if (/konstitutsiya/i.test(original) && articleNumber) {
    try {
      const constitutionUrl = `${LEXUZ_BASE_URL}/docs/-6445145`;
      console.log("LexUZ Konstitutsiya fallback:", constitutionUrl);
      const html = await lexUzFetch(constitutionUrl);
      const text = lexUzHtmlToText(html);
      const article = extractLexUzArticle(text, articleNumber);
      if (article) {
        return {
          answer: `📘 OʻZBEKISTON RESPUBLIKASI KONSTITUTSIYASI\n\n${article}\n\nManba: O‘zbekiston Respublikasi Qonunchilik ma’lumotlari milliy bazasi (LexUZ)`,
          source: "lexuz",
          title: "OʻZBEKISTON RESPUBLIKASI KONSTITUTSIYASI",
          url: constitutionUrl,
          article: articleNumber
        };
      }
    } catch (e) {
      console.error("LEXUZ CONSTITUTION FALLBACK ERROR:", e.message);
    }
  }

  const candidates = [];
  const seen = new Set();

  for (const query of queries.slice(0, 6)) {
    for (const searchParam of ["searchtitle", "searchtext"]) {
      try {
        const url = `${LEXUZ_BASE_URL}/uz/search/all?lang=4&${searchParam}=${encodeURIComponent(query)}`;
        console.log(`LexUZ qidiruvi [${searchParam}]:`, query);
        const html = await lexUzFetch(url);
        for (const item of parseLexUzSearchResults(html)) {
          if (!seen.has(item.url)) {
            seen.add(item.url);
            candidates.push(item);
          }
        }
      } catch (e) {
        console.error(`LEXUZ SEARCH ERROR [${searchParam}]:`, e.message);
      }
    }
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => scoreLexUzResult(cleaned || original, b) - scoreLexUzResult(cleaned || original, a));

  for (const candidate of candidates.slice(0, 8)) {
    try {
      const html = await lexUzFetch(candidate.url);
      const text = lexUzHtmlToText(html);
      if (!text) continue;

      const article = extractLexUzArticle(text, articleNumber);
      const title = candidate.title || "LexUZ hujjati";

      return {
        answer: articleNumber
          ? `📘 ${title}\n\n${article || `LexUZdan ${articleNumber}-modda bo‘yicha tegishli hujjat topildi.`}\n\nManba: O‘zbekiston Respublikasi Qonunchilik ma’lumotlari milliy bazasi (LexUZ)`
          : `📘 ${title}\n\n${text.slice(0, 5000)}\n\nManba: O‘zbekiston Respublikasi Qonunchilik ma’lumotlari milliy bazasi (LexUZ)`,
        source: "lexuz",
        title,
        url: candidate.url,
        article: articleNumber || null
      };
    } catch (e) {
      console.error("LEXUZ DOCUMENT ERROR:", candidate.url, e.message);
    }
  }

  return null;
}

// ============================================================
// END LEXUZ
// ============================================================


// ============================================================
// LUG‘AT — API KEY TALAB QILMAYDI
// Uzbek/Russian/English so‘zlar uchun Wiktionary,
// imkon bo‘lsa Dictionary API fallback.
// ============================================================

const DICTIONARY_API_BASE = "https://api.dictionaryapi.dev/api/v2/entries";

// Qamir AI ichki qisqa lug‘ati. Gemini bo‘lmasa ham asosiy
// IT atamalariga javob beradi. Keyin tashqi lug‘atlar fallback bo‘ladi.
const QAMIR_DICTIONARY = {
  kompyuter: {
    aliases: ["computer"],
    definition: "Ma’lumotlarni qayta ishlash, saqlash va turli dasturlarni ishga tushirish uchun ishlatiladigan elektron qurilma."
  },
  server: {
    aliases: ["server"],
    definition: "Tarmoqdagi boshqa qurilmalar yoki dasturlarga ma’lumot, xizmat yoki resurs taqdim etadigan kompyuter yoki dastur."
  },
  algoritm: {
    aliases: ["algorithm"],
    definition: "Muammoni hal qilish yoki vazifani bajarish uchun bosqichma-bosqich bajariladigan aniq ko‘rsatmalar ketma-ketligi."
  },
  vpn: {
    aliases: ["vpn"],
    definition: "Internet ulanishini shifrlash va foydalanuvchi qurilmasi bilan masofadagi tarmoq o‘rtasida himoyalangan aloqa yaratishga xizmat qiladigan texnologiya."
  },
  internet: {
    aliases: ["internet"],
    definition: "Dunyo bo‘ylab kompyuterlar va boshqa qurilmalarni o‘zaro bog‘laydigan global tarmoq."
  },
  dastur: {
    aliases: ["software", "program"],
    definition: "Kompyuter yoki boshqa qurilmada muayyan vazifani bajarish uchun yaratilgan dasturiy ta’minot."
  },
  fayl: {
    aliases: ["file"],
    definition: "Kompyuterda saqlanadigan ma’lumotlar to‘plami; masalan, hujjat, rasm, video yoki dastur fayli."
  },
  papka: {
    aliases: ["folder", "directory"],
    definition: "Fayllar va boshqa papkalarni tartibli saqlash uchun ishlatiladigan katalog."
  },
  tarmoq: {
    aliases: ["network"],
    definition: "Bir-biri bilan ma’lumot almashadigan qurilmalar va ulanishlar majmuasi."
  },
  brauzer: {
    aliases: ["browser"],
    definition: "Veb-saytlarni ochish va internetdagi sahifalar bilan ishlash uchun mo‘ljallangan dastur."
  },
  sayt: {
    aliases: ["website", "site"],
    definition: "Internetda bitta domen yoki manzil ostida joylashgan o‘zaro bog‘langan veb-sahifalar majmuasi."
  },
  baza: {
    aliases: ["database"],
    definition: "Ma’lumotlarni tartibli saqlash, boshqarish va izlash uchun mo‘ljallangan ma’lumotlar to‘plami."
  },
  "ma’lumotlar bazasi": {
    aliases: ["database"],
    definition: "Ma’lumotlarni tartibli saqlash, boshqarish va izlash uchun mo‘ljallangan ma’lumotlar to‘plami."
  },
  dasturchi: {
    aliases: ["programmer", "developer"],
    definition: "Dasturlar va dasturiy tizimlarni yaratadigan, sinaydigan va takomillashtiradigan mutaxassis."
  },
  kod: {
    aliases: ["code"],
    definition: "Dastur ishlashini ta’minlaydigan dasturlash tilida yozilgan buyruqlar va ko‘rsatmalar to‘plami."
  },
  api: {
    aliases: ["api"],
    definition: "Turli dastur va xizmatlarning bir-biri bilan ma’lumot almashishi uchun belgilangan interfeys va qoidalar to‘plami."
  },
  hosting: {
    aliases: ["hosting", "web hosting"],
    definition: "Sayt yoki server xizmatining internet orqali ishlashi uchun resurslarni joylashtirib beradigan xizmat."
  },
  domen: {
    aliases: ["domain"],
    definition: "Internetdagi saytning odamlar o‘qishi va eslab qolishi oson bo‘lgan nomi, masalan example.com."
  },
  protokol: {
    aliases: ["protocol"],
    definition: "Qurilmalar yoki dasturlar o‘rtasida ma’lumot almashish tartibini belgilovchi qoidalar to‘plami."
  },
  ip: {
    aliases: ["ip address", "ip"],
    definition: "Tarmoqdagi qurilmani aniqlash uchun ishlatiladigan raqamli manzil."
  },
  wifi: {
    aliases: ["wifi", "wi-fi"],
    definition: "Qurilmalarni simsiz tarmoqqa ulash uchun ishlatiladigan texnologiya."
  },
  bluetooth: {
    aliases: ["bluetooth"],
    definition: "Yaqin masofadagi qurilmalar o‘rtasida simsiz ma’lumot almashish texnologiyasi."
  },
  "operatsion tizim": {
    aliases: ["operating system", "os"],
    definition: "Kompyuterning apparat va dasturiy resurslarini boshqaradigan asosiy tizim dasturi, masalan Windows, Linux yoki Android."
  },
  windows: {
    aliases: ["windows"],
    definition: "Microsoft tomonidan ishlab chiqilgan kompyuterlar uchun operatsion tizimlar oilasi."
  },
  linux: {
    aliases: ["linux"],
    definition: "Unix-ga o‘xshash ochiq kodli operatsion tizimlar oilasi va uning yadrosi asosidagi tizimlar majmuasi."
  },
  android: {
    aliases: ["android"],
    definition: "Asosan smartfon va planshetlar uchun ishlatiladigan mobil operatsion tizim."
  },
  antivirus: {
    aliases: ["antivirus"],
    definition: "Zararli dasturlarni aniqlash, bloklash va o‘chirishga yordam beradigan dasturiy ta’minot."
  },
  virus: {
    aliases: ["computer virus"],
    definition: "Kompyuterga zarar yetkazishi, ma’lumotlarni o‘zgartirishi yoki boshqa tizimlarga tarqalishi mumkin bo‘lgan zararli dastur turi."
  },
  backup: {
    aliases: ["backup"],
    definition: "Muhim ma’lumotlarning yo‘qolib qolmasligi uchun yaratilgan zaxira nusxa."
  },
  shifrlash: {
    aliases: ["encryption"],
    definition: "Ma’lumotni maxsus usul yordamida begona shaxslar uchun o‘qib bo‘lmaydigan ko‘rinishga keltirish jarayoni."
  },
  parol: {
    aliases: ["password"],
    definition: "Hisob yoki tizimga kirishni himoyalash uchun ishlatiladigan maxfiy belgilar ketma-ketligi."
  },
  "bulutli xizmat": {
    aliases: ["cloud service", "cloud computing"],
    definition: "Hisoblash, saqlash yoki dasturiy xizmatlardan internet orqali masofadan foydalanish usuli."
  }
};

function normalizeDictionaryText(text) {
  return decodeHtmlEntities(String(text || ""))
    .toLowerCase()
    .replace(/[ʻ’‘`´]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeDictionaryQuestion(text) {
  const q = normalizeDictionaryText(text);
  if (!q || q.length < 2) return false;

  return [
    /\bnima\s+degani\b/i,
    /\bma['’]?nosi(?:\s+nima)?\b/i,
    /\bmanosi(?:\s+nima)?\b/i,
    /\bso['’]?z(?:ining|ning|i)?\s+ma['’]?nosi(?:\s+nima)?\b/i,
    /\bsoz(?:ining|ning|i)?\s+manosi(?:\s+nima)?\b/i,
    /\bso['’]?zi(?:\s+nima(?:\s+degani)?)?\b/i,
    /\bsoz(?:i(?:\s+nima(?:\s+degani)?)?)?\b/i,
    /\bta['’]?rif(?:i)?\b/i,
    /\bta'rif\s+ber\b/i,
    /\bizohi(?:\s+nima)?\b/i,
    /\blug['’]?at(?:dan)?\b/i,
    /\blugat(?:dan)?\b/i,
    /\blug['’]?at\s+.*\b(?:top|qidir|izla)\b/i,
    /\b(?:definition|meaning|meaning\s+of)\b/i,
    /\bwhat\s+(?:does|is)\b/i,
    /\bчто\s+значит\b/i,
    /\bзначение\b/i,
    /\bчто\s+такое\b/i
  ].some(pattern => pattern.test(q));
}

function cleanDictionaryQuery(text) {
  let q = decodeHtmlEntities(String(text || ""))
    .trim()
    .replace(/[ʻ’‘`´]/g, "'")
    .replace(/[“”«»]/g, '"')
    .replace(/[?!.]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // Buyruq shakli: lug‘atdan "algoritm" so‘zini top.
  let m = q.match(/^(?:lug['’]?atdan|lugatdan)\s+["']?(.+?)["']?\s+so['’]?z(?:ini|ni|i)?\s+(?:top|qidir|izla|topib\s+ber|qidirib\s+ber)\s*$/iu);
  if (m) return m[1].trim().replace(/^["']|["']$/g, "").slice(0, 160);

  m = q.match(/^["']?(.+?)["']?\s+so['’]?z(?:ining|ning)\s+ma['’]?nosi(?:\s+nima)?\s*$/iu);
  if (m) return m[1].trim().replace(/^["']|["']$/g, "").slice(0, 160);

  m = q.match(/^["']?(.+?)["']?\s+soz(?:ining|ning)\s+manosi(?:\s+nima)?\s*$/iu);
  if (m) return m[1].trim().replace(/^["']|["']$/g, "").slice(0, 160);

  m = q.match(/^(.+?)\s+(?:nima(?:\s+degani)?|meaning|definition)\s*$/iu);
  if (m) return m[1].trim().replace(/^["']|["']$/g, "").slice(0, 160);

  m = q.match(/^(.+?)ga\s+ta['’]?rif\s+ber\s*$/iu);
  if (m) return m[1].trim().replace(/["']/g, "").trim().slice(0, 160);

  m = q.match(/^(.+?)\s+ta['’]?rif\s+ber\s*$/iu);
  if (m) return m[1].trim().replace(/^["']|["']$/g, "").trim().slice(0, 160);

  q = q
    .replace(/^\s*(?:lug['’]?atdan|lugatdan|lug['’]?at|lugat)\s*[:,-]?\s*/iu, "")
    .replace(/^\s*(?:dictionary|dict)\s*[:,-]?\s*/iu, "")
    .replace(/^\s*(?:shu\s+so['’]?z|shu\s+soz)\s*/iu, "")
    .trim();

  const quoted = q.match(/^["']\s*([^"']{2,100})\s*["']/u);
  if (quoted) q = quoted[1].trim();

  q = q
    .replace(/^(?:what\s+does|meaning\s+of|definition\s+of|what\s+is)\s+/iu, "")
    .replace(/^(?:что\s+значит|что\s+такое|значение)\s+/iu, "")
    .trim();

  const marker = q.match(/\s+(?:so['’]?z(?:ining|ning|ini|ni|i)?|soz(?:ining|ning|ini|ni|i)?|ma['’]?nosi|manosi|nima\s+degani|nima\s+degan|ta['’]?rifi|tarifi|izohi|definition)\b[\s\S]*$/iu);
  if (marker && marker.index > 0) q = q.slice(0, marker.index).trim();

  q = q
    .replace(/\s+(?:topib\s+ber|qidirib\s+ber|qidir|top|izla|ber)\s*$/iu, "")
    .replace(/["']/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const words = q.split(/\s+/).filter(Boolean);
  if (words.length > 4) q = words.slice(0, 4).join(" ");

  return q.slice(0, 160);
}

function dictionaryLanguageCandidates(word) {
  const w = normalizeDictionaryText(word);
  const latin = /[a-z]/i.test(w);
  const cyrillic = /[а-яё]/i.test(w);

  if (cyrillic && !latin) return ["ru", "uz", "en"];
  if (latin) return ["uz", "en", "ru"];
  return ["uz", "en", "ru"];
}

async function dictionaryApiLookup(language, word) {
  const url = `${DICTIONARY_API_BASE}/${encodeURIComponent(language)}/${encodeURIComponent(word)}`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Accept": "application/json",
      "User-Agent": "QamirAI/1.0"
    },
    signal: AbortSignal.timeout(10000)
  });

  if (!response.ok) {
    throw new Error(`Dictionary API HTTP ${response.status}`);
  }

  const data = await response.json().catch(() => null);
  if (!Array.isArray(data) || !data.length) {
    throw new Error("Dictionary API bo‘sh javob qaytardi.");
  }

  const entries = [];

  for (const item of data) {
    const wordValue = String(item?.word || word).trim();

    for (const meaning of item?.meanings || []) {
      const part = String(meaning?.partOfSpeech || "").trim();
      for (const definition of meaning?.definitions || []) {
        const textValue = String(definition?.definition || "").trim();
        if (!textValue) continue;
        entries.push({
          word: wordValue,
          partOfSpeech: part,
          definition: textValue,
          example: String(definition?.example || "").trim()
        });
        if (entries.length >= 6) break;
      }
      if (entries.length >= 6) break;
    }
    if (entries.length >= 6) break;
  }

  return entries;
}

function extractWiktionaryText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/p>|<\/div>|<\/li>|<\/dd>|<\/dt>|<\/h[1-6]>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#039;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function wiktionaryLookup(language, word) {
  const base = `https://${language}.wiktionary.org/w/api.php`;

  async function request(paramsObject) {
    const params = new URLSearchParams({
      format: "json",
      formatversion: "2",
      origin: "*",
      ...paramsObject
    });

    const response = await fetch(`${base}?${params.toString()}`, {
      method: "GET",
      headers: {
        "Accept": "application/json",
        "User-Agent": "QamirAI/1.0 (Qamir AI personal assistant)"
      },
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) {
      throw new Error(`Wiktionary ${language} HTTP ${response.status}`);
    }

    return response.json().catch(() => ({}));
  }

  let data = await request({
    action: "query",
    prop: "extracts",
    explaintext: "1",
    exintro: "1",
    redirects: "1",
    titles: word
  });

  let page = Array.isArray(data?.query?.pages) ? data.query.pages[0] : null;

  if (page && !page.missing) {
    const extract = extractWiktionaryText(page.extract || "");
    if (extract) {
      return { title: String(page.title || word).trim(), extract };
    }
  }

  // Exact sahifa bo‘lmasa, Wiktionary ichki qidiruvidan eng yaqin yozuvni topamiz.
  const searchData = await request({
    action: "query",
    list: "search",
    srnamespace: "0",
    srsearch: word,
    srlimit: "5"
  });

  const candidates = Array.isArray(searchData?.query?.search)
    ? searchData.query.search
    : [];

  for (const item of candidates) {
    const title = String(item?.title || "").trim();
    if (!title) continue;

    const detailData = await request({
      action: "query",
      prop: "extracts",
      explaintext: "1",
      exintro: "1",
      redirects: "1",
      titles: title
    });

    const candidatePage = Array.isArray(detailData?.query?.pages)
      ? detailData.query.pages[0]
      : null;

    if (!candidatePage || candidatePage.missing) continue;

    const extract = extractWiktionaryText(candidatePage.extract || "");
    if (extract) {
      return { title: String(candidatePage.title || title).trim(), extract };
    }
  }

  return null;
}

function normalizeDictionaryWord(text) {
  return normalizeDictionaryText(text)
    .replace(/\b(?:a|an|the)\b/gi, " ")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function findInternalDictionaryEntry(word) {
  const target = normalizeDictionaryWord(word);
  if (!target) return null;

  for (const [key, entry] of Object.entries(QAMIR_DICTIONARY)) {
    if (normalizeDictionaryWord(key) === target) {
      return { key, ...entry };
    }

    for (const alias of entry.aliases || []) {
      if (normalizeDictionaryWord(alias) === target) {
        return { key, ...entry };
      }
    }
  }

  return null;
}

function makeDictionaryVariants(word) {
  const variants = [];
  const seen = new Set();
  const add = value => {
    const v = normalizeDictionaryWord(value);
    if (!v || seen.has(v)) return;
    seen.add(v);
    variants.push(v);
  };

  add(word);

  const internal = findInternalDictionaryEntry(word);
  if (internal) {
    for (const alias of internal.aliases || []) add(alias);
  }

  // O‘zbekcha oddiy ko‘plik/kelishik qo‘shimchalarini ehtiyotkorlik bilan olib tashlaymiz.
  const forms = [
    /(.+?)ning$/i,
    /(.+?)ni$/i,
    /(.+?)ga$/i,
    /(.+?)da$/i,
    /(.+?)dan$/i,
    /(.+?)lar$/i
  ];

  for (const re of forms) {
    const m = word.match(re);
    if (m && m[1].length >= 3) add(m[1]);
  }

  return variants.slice(0, 8);
}

async function getDictionaryAnswer(text) {
  if (!looksLikeDictionaryQuestion(text)) return null;

  const word = cleanDictionaryQuery(text);
  if (!word || word.length < 2) return null;

  // 1) Avval Qamir AI ichki lug‘ati. Bu qism Gemini API keysiz ham ishlaydi.
  const internal = findInternalDictionaryEntry(word);
  if (internal) {
    return {
      answer: `📖 ${internal.key}\n\n${internal.definition}`,
      source: "dictionary_internal",
      word: internal.key,
      language: "uz"
    };
  }

  // Qamir AI ichidagi Gemini kaliti mavjud bo‘lsa,
  // o‘zbekcha lug‘at so‘rovlari uchun birinchi navbatda
  // aniq lug‘aviy izoh olamiz. Alohida API key kerak emas.
  if (process.env.GEMINI_API_KEY) {
    try {
      const fallback = await askGemini(
        `Quyidagi so‘z yoki iboraning LUG‘AVIY ma’nosini o‘zbek tilida qisqa va aniq tushuntir. ` +
        `Faqat ta’rifni ber; manba, URL, "Manba:" yoki boshqa qidiruv izohlarini yozma. ` +
        `So‘z: ${word}`,
        [],
        []
      );

      if (fallback) {
        const cleaned = String(fallback)
          .replace(/^\s*manba\s*:\s*.*$/gim, "")
          .replace(/^\s*source\s*:\s*.*$/gim, "")
          .trim();

        if (cleaned) {
          return {
            answer: `📖 ${word}\n\n${cleaned}`,
            source: "dictionary_gemini",
            word,
            language: "uz"
          };
        }
      }
    } catch (e) {
      console.error("DICTIONARY GEMINI PRIMARY ERROR:", e.message);
    }
  }

  const languageCandidates = dictionaryLanguageCandidates(word);
  const variants = makeDictionaryVariants(word);

  // 2) Wiktionary — API key kerak emas. Bir nechta yozilish variantini sinaymiz.
  for (const language of languageCandidates) {
    for (const variant of variants) {
      try {
        const page = await wiktionaryLookup(language, variant);
      if (page) {
        const cleaned = page.extract
          .replace(/^(?:[A-Z][^\n]{0,80}\n){0,2}/, "")
          .trim();

        const clipped = cleaned.length > 2200
          ? `${cleaned.slice(0, 2200).trim()}…`
          : cleaned;

        if (clipped) {
          return {
            answer: `📖 ${page.title}\n\n${clipped}`,
            source: "dictionary_wiktionary",
            word: page.title,
            language
          };
        }
      }
      } catch (e) {
        console.error(`DICTIONARY WIKTIONARY ${language.toUpperCase()} VARIANT ERROR:`, e.message);
      }
    }
  }

  // 3) Free Dictionary API — asosan inglizcha/ruscha so‘zlar uchun.
  for (const language of languageCandidates) {
    if (language === "uz") continue;

    for (const variant of variants) {
      try {
        const entries = await dictionaryApiLookup(language, variant);
        if (!entries.length) continue;

        const lines = [`📖 ${entries[0].word}`];

        for (const item of entries.slice(0, 5)) {
          const prefix = item.partOfSpeech ? `${item.partOfSpeech}: ` : "";
          lines.push(`• ${prefix}${item.definition}`);
          if (item.example) lines.push(`  Misol: ${item.example}`);
        }

        return {
          answer: lines.join("\n"),
          source: "dictionary_api",
          word: entries[0].word,
          language
        };
      } catch (e) {
        console.error(`DICTIONARY API ${language.toUpperCase()} VARIANT ERROR:`, e.message);
      }
    }
  }

  return {
    answer: `“${word}” so‘zi bo‘yicha lug‘at ma’lumoti topilmadi.`,
    source: "dictionary_not_found",
    word
  };
}

// ============================================================
// END LUG‘AT
// ============================================================

// ============================================================
// AQLLI QIDIRUV — API KEY TALAB QILMAYDI
// DuckDuckGo Instant Answer + HTML natijalar fallback.
// Faqat aniq qidiruv buyrug‘i bo‘lsa ishga tushadi.
// ============================================================

const DUCKDUCKGO_INSTANT_URL = "https://api.duckduckgo.com/";
const DUCKDUCKGO_HTML_URL = "https://html.duckduckgo.com/html/";

function normalizeSmartSearchText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[ʻ’‘`´]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeSmartSearchQuestion(text) {
  const q = normalizeSmartSearchText(text);
  if (!q || q.length < 3) return false;

  const patterns = [
    /\binternet(?:dan|da)?\b[\s\S]{0,120}\b(?:qidir|top|izla|yangilik|ma['’]?lumot)\b/i,
    /\bweb(?:dan|da)?\b[\s\S]{0,120}\b(?:qidir|top|izla|yangilik|ma['’]?lumot)\b/i,
    /\bgoogle(?:da|dan)?\b[\s\S]{0,120}\b(?:qidir|top|izla)\b/i,
    /\bqidirib\s+ber\b/i,
    /\btopib\s+ber\b/i,
    /\b(?:qidir|top|izla)\b[\s\S]{0,120}\b(?:internet|web|google)\b/i,
    /\byangilik(?:lar|larni)?\b[\s\S]{0,100}\b(?:qidir|top|ber|izla)\b/i,
    /\beng\s+(?:so‘nggi|songgi|yangi)\s+ma['’]?lumot\b/i,
    /\bsearch\s+(?:for|on)\b/i,
    /\binternet\s+qidiruvi\b/i,
    /\baqlli\s+qidiruv\b/i
  ];

  return patterns.some(pattern => pattern.test(q));
}

function cleanSmartSearchQuery(text) {
  let q = String(text || "")
    .trim()
    .replace(/[?!.]+$/g, "")
    .replace(/^\s*(?:internetdan|internetda|webdan|webda|google(?:da|dan)?)\s*/iu, "")
    .replace(/^\s*(?:internetga|webga)\s*/iu, "")
    .replace(/^(?:qidirib\s+ber|qidir|topib\s+ber|top|izla|search\s+(?:for|on))\s*:?-?\s*/iu, "")
    .replace(/^(?:ma['’]lumot\s+izla|malumot\s+izla|internet\s+qidiruvi|aqlli\s+qidiruv)\s*:?-?\s*/iu, "")
    .replace(/^(?:shu\s+haqida|shu\s+mavzuda)\s*/iu, "")
    .replace(/\s+(?:topib\s+ber|qidirib\s+ber|qidir|top|izla|ber)\s*$/iu, "")
    .replace(/\b(?:internetdan|internetda|webdan|webda|google(?:da|dan)?)\s+(?:qidir|top|izla)\b/iu, "")
    .replace(/\s+/g, " ")
    .trim();

  return q.slice(0, 300);
}

function decodeHtmlEntities(text) {
  return String(text || "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#39;|&#039;|&#x27;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&ndash;/gi, "–")
    .replace(/&mdash;/gi, "—")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : _;
    })
    .replace(/&#([0-9]+);/g, (_, dec) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : _;
    });
}

function stripHtml(text) {
  return decodeHtmlEntities(
    String(text || "")
      .replace(/<br\s*\/?\s*>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
  ).trim();
}

async function smartSearchInstant(query) {
  const url = `${DUCKDUCKGO_INSTANT_URL}?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1&no_redirect=1&kl=us-en`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Accept": "application/json",
      "User-Agent": "QamirAI/1.0 (Qamir AI personal assistant)"
    },
    signal: AbortSignal.timeout(10000)
  });

  if (!response.ok) {
    throw new Error(`DuckDuckGo Instant HTTP ${response.status}`);
  }

  const data = await response.json().catch(() => ({}));
  const results = [];

  if (data?.AbstractText || data?.AbstractURL) {
    results.push({
      title: String(data?.Heading || query).trim(),
      snippet: String(data?.AbstractText || data?.Answer || "").trim(),
      url: String(data?.AbstractURL || "").trim()
    });
  }

  const topics = [];
  const collectTopics = list => {
    for (const item of Array.isArray(list) ? list : []) {
      if (Array.isArray(item?.Topics)) {
        collectTopics(item.Topics);
        continue;
      }
      const text = String(item?.Text || "").trim();
      const firstUrl = String(item?.FirstURL || "").trim();
      if (text || firstUrl) {
        topics.push({
          title: text.split(" - ")[0] || query,
          snippet: text,
          url: firstUrl
        });
      }
    }
  };

  collectTopics(data?.RelatedTopics);
  for (const item of topics.slice(0, 5)) results.push(item);

  return results.filter(item => item.title || item.snippet || item.url).slice(0, 6);
}

async function smartSearchHtml(query) {
  const url = `${DUCKDUCKGO_HTML_URL}?q=${encodeURIComponent(query)}&kl=us-en&kp=-2`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "uz,ru;q=0.8,en;q=0.7",
      "User-Agent": "Mozilla/5.0 (compatible; QamirAI/1.0)"
    },
    signal: AbortSignal.timeout(12000)
  });

  if (!response.ok) throw new Error(`DuckDuckGo HTML HTTP ${response.status}`);

  const html = await response.text();
  const results = [];
  const seen = new Set();

  const hrefRe = /<a[^>]+class=["']result__a["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const matches = [...html.matchAll(hrefRe)];

  for (let i = 0; i < matches.length && results.length < 6; i++) {
    const match = matches[i];
    const start = match.index || 0;
    const nextStart = i + 1 < matches.length ? (matches[i + 1].index || html.length) : Math.min(html.length, start + 5000);
    const segment = html.slice(start, nextStart);

    let urlValue = decodeHtmlEntities(match[1]);
    const title = stripHtml(match[2]);

    try {
      const parsed = new URL(urlValue, DUCKDUCKGO_HTML_URL);
      const uddg = parsed.searchParams.get("uddg");
      if (uddg) urlValue = uddg;
    } catch {}

    const snippetMatch = segment.match(/<(?:a|div)[^>]+class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div)>/i);
    const snippet = stripHtml(snippetMatch ? snippetMatch[1] : "");

    if (!urlValue || !title) continue;
    if (/^(javascript:|mailto:)/i.test(urlValue)) continue;
    if (seen.has(urlValue)) continue;

    seen.add(urlValue);
    results.push({ title, snippet, url: urlValue });
  }

  return results;
}

async function getSmartSearchAnswer(text) {
  if (!looksLikeSmartSearchQuestion(text)) return null;

  const query = cleanSmartSearchQuery(text);
  if (!query || query.length < 2) {
    return {
      answer: "Nimani internetdan qidirish kerakligini yozing.",
      source: "smart_search_error"
    };
  }

  let results = [];

  try {
    results = await smartSearchInstant(query);
  } catch (e) {
    console.error("SMART SEARCH INSTANT ERROR:", e.message);
  }

  if (results.length < 2) {
    try {
      const htmlResults = await smartSearchHtml(query);
      const seen = new Set(results.map(item => item.url).filter(Boolean));
      for (const item of htmlResults) {
        if (item.url && seen.has(item.url)) continue;
        if (item.url) seen.add(item.url);
        results.push(item);
        if (results.length >= 6) break;
      }
    } catch (e) {
      console.error("SMART SEARCH HTML ERROR:", e.message);
    }
  }

  if (!results.length) {
    return {
      answer: `“${query}” bo‘yicha internet qidiruvida hozircha natija topilmadi.`,
      source: "smart_search_empty",
      query
    };
  }

  const lines = [`🔎 Aqlli qidiruv: ${query}`, ""];

  results.slice(0, 5).forEach((item, index) => {
    lines.push(`${index + 1}. ${item.title}`);
    if (item.snippet) lines.push(`   ${item.snippet}`);
    if (item.url) lines.push(`   ${item.url}`);
    lines.push("");
  });

  return {
    answer: lines.join("\n").trim(),
    source: "smart_search",
    query,
    results: results.slice(0, 5)
  };
}

// ============================================================
// END AQLLI QIDIRUV
// ============================================================

// ============================================================
// ADVANCED CALCULATOR
// ============================================================
function formatNumber(value){ if(Object.is(value,-0))value=0; if(Number.isInteger(value))return String(value); return Number(value.toFixed(12)).toLocaleString("uz-UZ",{maximumFractionDigits:12,useGrouping:false}); }
function factorial(n){n=Number(n);if(!Number.isInteger(n)||n<0||n>170)throw new Error("Faktorial uchun 0 dan 170 gacha butun son kerak.");let r=1;for(let i=2;i<=n;i++)r*=i;return r;}
function degToRad(x){return x*Math.PI/180;} function radToDeg(x){return x*180/Math.PI;}
function normalizeMathQuestion(text){let q=String(text||"").trim().toLowerCase().replace(/[ʻ’‘`´]/g,"").replace(/[−–—]/g,"-").replace(/[×✕]/g,"*").replace(/÷/g,"/").replace(/\s+/g," ");if(!/[a-zA-Z]+\s*\([^)]*,/.test(q))q=q.replace(/(\d)\s*,\s*(\d)/g,"$1.$2");return q;}
function calculatePercentage(text){
  const q=normalizeMathQuestion(text).replace(/\?+$/g,"").trim();let m;
  m=q.match(/^(-?\d+(?:\.\d+)?)\s*ning\s+(-?\d+(?:\.\d+)?)\s*(?:foiz|foizi|foizini|%)\s*(?:qancha|necha|bo'ladi|boladi)?$/i); if(m){const base=Number(m[1]),percent=Number(m[2]),result=base*percent/100;return{answer:`${formatNumber(base)} ning ${formatNumber(percent)}% = ${formatNumber(result)}`,result};}
  m=q.match(/^(?:hisobla|hisoblab\s+ber|top|aniqla)\s+(-?\d+(?:\.\d+)?)\s*ning\s+(-?\d+(?:\.\d+)?)\s*(?:foiz|foizi|foizini|%)$/i); if(m){const base=Number(m[1]),percent=Number(m[2]),result=base*percent/100;return{answer:`${formatNumber(base)} ning ${formatNumber(percent)}% = ${formatNumber(result)}`,result};}
  m=q.match(/^(-?\d+(?:\.\d+)?)\s*(?:foiz|foizi|foizini|%)\s+(?:ning\s+)?(-?\d+(?:\.\d+)?)(?:\s+dan)?$/i); if(m){const percent=Number(m[1]),base=Number(m[2]),result=base*percent/100;return{answer:`${formatNumber(percent)}% ${formatNumber(base)} ning = ${formatNumber(result)}`,result};}
  m=q.match(/^(-?\d+(?:\.\d+)?)\s*%\s*(?:of|dan|ning)\s*(-?\d+(?:\.\d+)?)$/i); if(m){const percent=Number(m[1]),base=Number(m[2]),result=base*percent/100;return{answer:`${formatNumber(percent)}% of ${formatNumber(base)} = ${formatNumber(result)}`,result};}
  m=q.match(/^(-?\d+(?:\.\d+)?)\s+dan\s+(-?\d+(?:\.\d+)?)\s*%\s*(?:ayir|ayirish|kamaytir|kamaytirish)$/i); if(m){const base=Number(m[1]),percent=Number(m[2]),result=base-base*percent/100;return{answer:`${formatNumber(base)} dan ${formatNumber(percent)}% ayirilsa = ${formatNumber(result)}`,result};}
  m=q.match(/^(-?\d+(?:\.\d+)?)\s+ga\s+(-?\d+(?:\.\d+)?)\s*%\s*(?:qo'sh|qosh|qo'shish|qoshish|oshir|oshirish)$/i); if(m){const base=Number(m[1]),percent=Number(m[2]),result=base+base*percent/100;return{answer:`${formatNumber(base)} ga ${formatNumber(percent)}% qo‘shilsa = ${formatNumber(result)}`,result};}
  m=q.match(/^(-?\d+(?:\.\d+)?)\s*([+-])\s*(-?\d+(?:\.\d+)?)\s*%$/); if(m){const base=Number(m[1]),op=m[2],percent=Number(m[3]),delta=base*percent/100,result=op==='+'?base+delta:base-delta;return{answer:`${formatNumber(base)} ${op} ${formatNumber(percent)}% = ${formatNumber(result)}`,result};}
  return null;
}
function tokenizeMathExpression(expression){const tokens=[];let i=0;while(i<expression.length){const ch=expression[i];if(/\s/.test(ch)){i++;continue;}if(/[0-9.]/.test(ch)){const start=i;let dots=0;while(i<expression.length&&/[0-9.]/.test(expression[i])){if(expression[i]==='.')dots++;i++;}const raw=expression.slice(start,i);if(dots>1||raw==='.')throw new Error("Noto‘g‘ri son");const value=Number(raw);if(!Number.isFinite(value))throw new Error("Noto‘g‘ri son");tokens.push({type:"number",value});continue;}if(/[a-zA-Z]/.test(ch)){const start=i;while(i<expression.length&&/[a-zA-Z]/.test(expression[i]))i++;tokens.push({type:"identifier",value:expression.slice(start,i).toLowerCase()});continue;}if("+-*/%^(),!".includes(ch)){tokens.push({type:ch,value:ch});i++;continue;}throw new Error("Noma’lum matematik belgi");}return tokens;}
function evaluateAdvancedExpression(expression){
  const tokens=tokenizeMathExpression(expression);let pos=0;const constants={pi:Math.PI,e:Math.E};const functions={sqrt:x=>Math.sqrt(x),abs:x=>Math.abs(x),floor:x=>Math.floor(x),ceil:x=>Math.ceil(x),round:x=>Math.round(x),sin:x=>Math.sin(degToRad(x)),cos:x=>Math.cos(degToRad(x)),tan:x=>Math.tan(degToRad(x)),asin:x=>radToDeg(Math.asin(x)),acos:x=>radToDeg(Math.acos(x)),atan:x=>radToDeg(Math.atan(x)),ln:x=>Math.log(x),log:x=>Math.log10(x),exp:x=>Math.exp(x),pow:(a,b)=>Math.pow(a,b),min:(...a)=>Math.min(...a),max:(...a)=>Math.max(...a),fact:factorial};
  const finite=v=>{if(typeof v!=="number"||!Number.isFinite(v))throw new Error("Matematik natija yaroqsiz");return v;};
  function parseExpression(){let v=parseTerm();while(pos<tokens.length&&(tokens[pos].type==='+'||tokens[pos].type==='-')){const op=tokens[pos++].type,r=parseTerm();v=op==='+'?v+r:v-r;finite(v);}return v;}
  function parseTerm(){let v=parsePower();while(pos<tokens.length&&('* / %'.includes(tokens[pos].type))){const op=tokens[pos++].type,r=parsePower();if((op==='/'||op==='%')&&r===0)throw new Error("0 ga bo‘lish mumkin emas");v=op==='*'?v*r:op==='/'?v/r:v%r;finite(v);}return v;}
  function parsePower(){let v=parseUnary();if(pos<tokens.length&&tokens[pos].type==='^'){pos++;v=Math.pow(v,parsePower());finite(v);}return v;}
  function parseUnary(){if(pos<tokens.length&&tokens[pos].type==='+'){pos++;return parseUnary();}if(pos<tokens.length&&tokens[pos].type==='-'){pos++;return finite(-parseUnary());}return parsePostfix();}
  function parsePostfix(){let v=parsePrimary();while(pos<tokens.length){if(tokens[pos].type==='!'){pos++;v=factorial(v);continue;}if(tokens[pos].type==='%'){const next=tokens[pos+1];if(!next||[')', '+', '-'].includes(next.type)){pos++;v/=100;continue;}}break;}return finite(v);}
  function parsePrimary(){if(pos>=tokens.length)throw new Error("Ifoda tugallanmagan");const t=tokens[pos];if(t.type==='number'){pos++;return t.value;}if(t.type==='identifier'){pos++;const name=t.value;if(pos<tokens.length&&tokens[pos].type==='('){pos++;const args=[];if(pos<tokens.length&&tokens[pos].type!==')'){args.push(parseExpression());while(pos<tokens.length&&tokens[pos].type===','){pos++;args.push(parseExpression());}}if(pos>=tokens.length||tokens[pos].type!==')')throw new Error("Funksiya qavsi yopilmagan");pos++;if(!Object.prototype.hasOwnProperty.call(functions,name))throw new Error(`Noma’lum funksiya: ${name}`);let result;if(name==='pow'){if(args.length!==2)throw new Error("pow(a,b) ikkita qiymat oladi");result=functions[name](args[0],args[1]);}else if(name==='min'||name==='max'){if(!args.length)throw new Error(`${name}() kamida bitta qiymat oladi`);result=functions[name](...args);}else{if(args.length!==1)throw new Error(`${name}() bitta qiymat oladi`);result=functions[name](args[0]);}return finite(result);}if(Object.prototype.hasOwnProperty.call(constants,name))return constants[name];throw new Error(`Noma’lum matematik nom: ${name}`);}if(t.type==='('){pos++;const v=parseExpression();if(pos>=tokens.length||tokens[pos].type!==')')throw new Error("Qavslar noto‘g‘ri");pos++;return v;}throw new Error("Ifoda noto‘g‘ri");}
  const result=parseExpression();if(pos!==tokens.length)throw new Error("Ifodaning bir qismi tushunilmadi");return finite(result);
}
function parsePoly(poly){let clean=poly.replace(/[()]/g,"").replace(/-/g,"+-");if(clean.startsWith('+'))clean=clean.slice(1);const terms=clean.split('+').filter(Boolean);let a=0,b=0,c=0;for(let term of terms){term=term.replace(/\*/g,"");let m=term.match(/^([+-]?\d*\.?\d*)x\^2$/);if(m){let k=m[1];a+=k===''||k==='+'?1:k==='-'?-1:Number(k);continue;}m=term.match(/^([+-]?\d*\.?\d*)x$/);if(m){let k=m[1];b+=k===''||k==='+'?1:k==='-'?-1:Number(k);continue;}if(/^[+-]?\d*\.?\d+$/.test(term)){c+=Number(term);continue;}return null;}return{a,b,c};}
function solveQuadratic(text){let q=normalizeMathQuestion(text).replace(/x²/g,'x^2').replace(/\s+/g,'');if(!q.includes('=')||!q.includes('x'))return null;const parts=q.split('=');if(parts.length!==2)return null;const l=parsePoly(parts[0]),r=parsePoly(parts[1]);if(!l||!r)return null;const a=l.a-r.a,b=l.b-r.b,c=l.c-r.c;if(Math.abs(a)<1e-12&&Math.abs(b)<1e-12)return null;if(Math.abs(a)<1e-12)return{answer:`Tenglama yechimi: x = ${formatNumber(-c/b)}`};const D=b*b-4*a*c;if(D<0){const real=-b/(2*a),imag=Math.sqrt(-D)/Math.abs(2*a);return{answer:`Diskriminant D = ${formatNumber(D)}.\nHaqiqiy ildiz yo‘q.\nKompleks ildizlar:\nx₁ = ${formatNumber(real)} + ${formatNumber(imag)}i\nx₂ = ${formatNumber(real)} - ${formatNumber(imag)}i`};}if(Math.abs(D)<1e-12)return{answer:`Diskriminant D = 0.\nYagona ildiz: x = ${formatNumber(-b/(2*a))}`};const s=Math.sqrt(D);return{answer:`Diskriminant D = ${formatNumber(D)}.\nx₁ = ${formatNumber((-b+s)/(2*a))}\nx₂ = ${formatNumber((-b-s)/(2*a))}`};}
function derivativePolynomial(text){const q=normalizeMathQuestion(text);if(!q.includes('d/dx')&&!q.includes('hosila'))return null;let expr=q.replace(/^.*d\/dx\s*\(?/i,'').replace(/\)?\s*$/g,'').replace(/^.*hosila\s*[:=]?\s*/i,'').replace(/x²/g,'x^2').replace(/\s+/g,'');const terms=expr.replace(/-/g,'+-').split('+').filter(Boolean),out=[];for(const original of terms){const term=original.replace(/\*/g,'');if(term==='x'){out.push('1');continue;}let m=term.match(/^([+-]?\d*\.?\d*)x\^(\d+(?:\.\d+)?)$/);if(m){let coef=m[1]===''||m[1]==='+'?1:m[1]==='-'?-1:Number(m[1]);const p=Number(m[2]),nc=coef*p,np=p-1;out.push(Math.abs(np)<1e-12?formatNumber(nc):Math.abs(np-1)<1e-12?`${formatNumber(nc)}x`:`${formatNumber(nc)}x^${formatNumber(np)}`);continue;}m=term.match(/^([+-]?\d*\.?\d*)x$/);if(m){let coef=m[1]===''||m[1]==='+'?1:m[1]==='-'?-1:Number(m[1]);out.push(formatNumber(coef));continue;}if(/^[+-]?\d*\.?\d+$/.test(term))continue;return null;}return{answer:out.length?`Hosila: ${out.join(' + ').replace(/\+\s+-/g,'- ')}`:"Hosila: 0"};}
function definitePolynomialIntegral(text){const q=normalizeMathQuestion(text);if(!q.includes('integral')&&!q.includes('∫'))return null;let expression='',lower=null,upper=null,m=q.match(/(?:integral|∫)\s*(-?\d+(?:\.\d+)?)\s*(?:dan|to|-)\s*(-?\d+(?:\.\d+)?)\s*(?:gacha)?\s+(.+)/);if(m){lower=Number(m[1]);upper=Number(m[2]);expression=m[3];}if(lower===null||upper===null){m=q.match(/(.+?)\s+(?:dan|from)\s+(-?\d+(?:\.\d+)?)\s+(?:gacha|to)\s+(-?\d+(?:\.\d+)?)/);if(m){expression=m[1];lower=Number(m[2]);upper=Number(m[3]);}}if(lower===null||upper===null||!Number.isFinite(lower)||!Number.isFinite(upper)||!expression)return null;const terms=expression.replace(/x²/g,'x^2').replace(/\s+/g,'').replace(/-/g,'+-').split('+').filter(Boolean);function F(x){let total=0;for(let term of terms){term=term.replace(/\*/g,'');let m=term.match(/^([+-]?\d*\.?\d*)x\^(\d+(?:\.\d+)?)$/);if(m){let c=m[1]===''||m[1]==='+'?1:m[1]==='-'?-1:Number(m[1]),p=Number(m[2]);total+=c*Math.pow(x,p+1)/(p+1);continue;}m=term.match(/^([+-]?\d*\.?\d*)x$/);if(m){let c=m[1]===''||m[1]==='+'?1:m[1]==='-'?-1:Number(m[1]);total+=c*x*x/2;continue;}if(/^[+-]?\d*\.?\d+$/.test(term)){total+=Number(term)*x;continue;}throw new Error('integral');}return total;}try{return{answer:`Aniq integral natijasi: ${formatNumber(F(upper)-F(lower))}`};}catch{return null;}}
function prepareMathExpression(expression){return String(expression||'').trim().replace(/π/g,'pi').replace(/√\s*([0-9.]+)/g,'sqrt($1)').replace(/(\d+(?:\.\d+)?)%(?=\s*(?:$|[+\-*/^)]))/g,'($1/100)').replace(/(\d+(?:\.\d+)?)%(?=\s*\))/g,'($1/100)');}
function tryCalculate(text){const original=String(text||'').trim();if(!original)return null;const pct=calculatePercentage(original);if(pct)return{expression:original,result:pct.result,answer:`Javob: ${pct.answer}`};const quad=solveQuadratic(original);if(quad)return{expression:original,result:null,answer:quad.answer};const der=derivativePolynomial(original);if(der)return{expression:original,result:null,answer:der.answer};const integ=definitePolynomialIntegral(original);if(integ)return{expression:original,result:null,answer:integ.answer};let expression=normalizeMathQuestion(original).replace(/^(hisobla|hisoblab ber|hisob-kitob|calculate)\s*/i,'').replace(/^(necha|qancha|natijasi)\s+boladi\s*/i,'').replace(/\?+$/g,'').trim();expression=prepareMathExpression(expression);if(!/[0-9]/.test(expression)||(!/[+\-*/%^()]/.test(expression)&&!(/\b(sqrt|sin|cos|tan|asin|acos|atan|log|ln|exp|abs|floor|ceil|round|fact|pow|min|max)\b/i.test(expression)||/\bpi\b|\be\b/i.test(expression))))return null;if(!/^[0-9a-zA-Z_+\-*/%^().,\s√]+$/u.test(expression))return null;try{const result=evaluateAdvancedExpression(expression);return{expression,result,answer:`Javob: ${formatNumber(result)}`};}catch(e){console.error('CALCULATOR ERROR:',e.message);return null;}}

// ============================================================
// TRANSLATOR — command required; no API key
// Google public -> LibreTranslate 1 -> LibreTranslate 2
// ============================================================
const TRANSLATION_LANGUAGES = {
  uz:["uzbek","uzbekcha","uzbekga","uzbekchaga","ozbek","ozbekcha","ozbekga","ozbekchaga","o'zbek","o'zbekcha","o'zbekga","o'zbekchaga","узбек","узбекский","узбекча","uz"],
  ru:["rus","ruscha","rusga","ruschaga","russ","russian","русский","русскому","русча","руска","руский","ru"],
  en:["ingliz","inglizcha","inglizga","inglizchaga","inglis","inglischa","inglich","inglichcha","english","английский","английскому","англич","en"],
  kk:["qozoq","qozoqcha","qozoqqa","qozoqchaga","qazaq","kazakh","қазақ","қазақша","казахский","kk"],
  tr:["turk","turkcha","turkka","turkchaga","turkish","türkçe","турецкий","tr"],
  tg:["tojik","tojikcha","tojikka","tojikchaga","tajik","тоҷик","таджикский","tg"],
  ar:["arab","arabcha","arabga","arabchaga","arabic","арабский","العربية","ar"],
  de:["nemis","nemischa","nemisga","nemischaga","german","deutsch","немецкий","de"],
  fr:["fransuz","fransuzcha","fransuzga","fransuzchaga","french","français","французский","fr"],
  es:["ispan","ispancha","ispanga","ispanchaga","spanish","español","испанский","es"],
  it:["italyan","italyancha","italyanga","italyanchaga","italian","italiano","итальянский","it"],
  zh:["xitoy","xitoycha","xitoyga","xitoychaga","chinese","中文","китайский","zh"],
  ko:["koreys","koreyscha","koreysga","koreyschaga","korean","한국어","корейский","ko"],
  ja:["yapon","yaponcha","yaponga","yaponchaga","japanese","日本語","японский","ja"],
  hi:["hind","hindcha","hindga","hindchaga","hindi","हिन्दी","хиндӣ","hi"],
  pt:["portugal","portugalcha","portugalga","portugalchaga","portuguese","português","португальский","pt"]
};
function normalizeTranslationText(text){return String(text||'').toLowerCase().replace(/[ʻ’‘`´]/g,"'").replace(/[?!.,;:()[\]{}]/g,' ').replace(/\s+/g,' ').trim();}
function normalizeTranslationAlias(text){return normalizeTranslationText(text).replace(/\btiliga\b/g,'').replace(/\btilga\b/g,'').replace(/\btil\b/g,'').trim();}
function translationLanguageCode(input){const value=normalizeTranslationAlias(input);if(!value)return null;let bestCode=null,bestScore=0;for(const [code,aliases] of Object.entries(TRANSLATION_LANGUAGES)){for(const alias of aliases){const a=normalizeTranslationAlias(alias);if(!a)continue;if(value===a)return code;if(value.includes(a)){if(bestScore<100){bestCode=code;bestScore=100;}continue;}if(value.split(/\s+/).length===1&&a.split(/\s+/).length===1){const d=levenshtein(value,a);if(d<=1&&bestScore<95){bestCode=code;bestScore=95;}else if(d<=2&&bestScore<85){bestCode=code;bestScore=85;}}}}return bestCode;}
function extractTranslationTarget(text){const normalized=normalizeTranslationText(text);let bestCode=null,bestLength=0;for(const [code,aliases] of Object.entries(TRANSLATION_LANGUAGES)){for(const alias of aliases){const a=normalizeTranslationAlias(alias);if(!a)continue;const escaped=a.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');const pattern=new RegExp(`(?:^|\\s|:|-)(?:${escaped})(?=\\s|:|-|$)`,'iu');if(pattern.test(normalized)&&a.length>bestLength){bestCode=code;bestLength=a.length;}}}if(bestCode)return bestCode;for(const word of normalized.split(/\s+/).filter(Boolean)){const code=translationLanguageCode(word);if(code)return code;}return null;}
function removeTranslationCommand(text,targetCode){let value=String(text||'').trim();const aliases=[...(TRANSLATION_LANGUAGES[targetCode]||[])].sort((a,b)=>b.length-a.length);for(const alias of aliases){const escaped=normalizeTranslationAlias(alias).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');value=value.replace(new RegExp(`(?:^|\\s|:|-)(?:${escaped})(?=\\s|:|-|$)`,'giu'),' ');}value=value.replace(/(?:^|\s)(?:shu\s+gapni|shu\s+matnni|shu\s+matn|shu\s+gap|matnni|gapni)(?=\s|:|$)/iu,' ').replace(/(?:^|\s)(?:tarjima\s+qil|tarjima\s+qilib\s+ber|tarjima|tarjma|o'gir|ogir|o'girish|ogirish|perevod\s+qil|perevod|perevot\s+qil|perevot|perewot|переведи|перевод|translate)(?=\s|:|$)/iu,' ').replace(/^(?:to|into|на|на\s+язык|к|для)\s+/iu,'');const colon=value.indexOf(':');if(colon>=0){const left=normalizeTranslationText(value.slice(0,colon));if(/(?:tarjima|tarjma|o'g|ogir|perevod|perevot|translate|рус|инглиз|ruscha|ruschaga|inglizcha|inglizchaga|uzbekcha|ozbekcha)/iu.test(left))value=value.slice(colon+1);}return value.replace(/^(?:shu\s+gapni|shu\s+matnni|shu\s+matn|shu\s+gap|matnni|gapni)\s*/iu,'').replace(/^(?:tarjima\s+qil|tarjima\s+qilib\s+ber|tarjima|tarjma|o'gir|ogir|o'girish|ogirish|perevod\s+qil|perevod|perevot\s+qil|perevot|perewot|переведи|перевод|translate)\s*:?\s*/iu,'').replace(/\s+(?:ni|nı)\s*$/iu,'').replace(/^[\s:,\-]+/,'').replace(/[\s:,\-]+$/,'').replace(/\s+/g,' ').trim();}
function findTranslationIntent(text){const original=String(text||'').trim();if(!original)return null;const q=normalizeTranslationText(original);const hasCommand=/(?:^|\s)(tarjima\s+qil|tarjima\s+qilib\s+ber|tarjima|tarjma|o'gir|ogir|o'girish|ogirish|perevod\s+qil|perevod|perevot\s+qil|perevot|perewot|translate|перевод|переведи)(?=\s|:|$)/iu.test(q);if(!hasCommand)return null;const targetCode=extractTranslationTarget(original);if(!targetCode)return{targetCode:null,sourceText:"",error:"Tarjima tilini aniqlab bo‘lmadi. Masalan: «perevot ruschaga: Salom» deb yozing."};const sourceText=removeTranslationCommand(original,targetCode);if(!sourceText)return{targetCode,sourceText:"",error:"Tarjima qilinadigan matn topilmadi."};return{targetCode,sourceText};}
async function translateWithGooglePublic(sourceText,targetCode){const url='https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl='+encodeURIComponent(targetCode)+'&dt=t&q='+encodeURIComponent(sourceText);const response=await fetch(url,{headers:{Accept:'application/json','User-Agent':'QamirAI/1.0'},signal:AbortSignal.timeout(12000)});if(!response.ok)throw new Error(`Google Translate HTTP ${response.status}`);const data=await response.json().catch(()=>null);if(!data)throw new Error('Google Translate javobi JSON emas.');const translated=Array.isArray(data[0])?data[0].filter(x=>Array.isArray(x)&&typeof x[0]==='string').map(x=>x[0]).join('').trim():'';if(!translated)throw new Error('Google Translate tarjima qaytarmadi.');return{text:translated,detectedSource:typeof data[2]==='string'?data[2]:''};}
const LIBRETRANSLATE_ENDPOINTS=['https://translate.cutie.dating/translate','https://translate.fedilab.app/translate'];
async function translateWithLibreTranslate(sourceText,targetCode){let last='LibreTranslate serverlari javob bermadi.';for(const endpoint of LIBRETRANSLATE_ENDPOINTS){try{const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json','User-Agent':'QamirAI/1.0'},body:JSON.stringify({q:sourceText,source:'auto',target:targetCode,format:'text'}),signal:AbortSignal.timeout(15000)});const data=await response.json().catch(()=>({}));if(!response.ok){last=data?.error||`LibreTranslate HTTP ${response.status}`;continue;}const translated=data?.translatedText;if(typeof translated==='string'&&translated.trim())return{text:translated.trim(),detectedSource:data?.detectedLanguage?.language||data?.detectedSourceLanguage||''};last='LibreTranslate javobida translatedText topilmadi.';}catch(e){last=e?.message||'LibreTranslate ulanish xatosi';console.error('LibreTranslate endpoint xatosi:',endpoint,last);}}throw new Error(last);}
async function tryTranslate(text){const intent=findTranslationIntent(text);if(!intent)return null;if(intent.error)throw new Error(intent.error);try{const r=await translateWithGooglePublic(intent.sourceText,intent.targetCode);return{sourceText:intent.sourceText,targetCode:intent.targetCode,translated:r.text,detectedSource:r.detectedSource};}catch(googleError){console.error('GOOGLE PUBLIC TRANSLATE ERROR:',googleError.message);try{const r=await translateWithLibreTranslate(intent.sourceText,intent.targetCode);return{sourceText:intent.sourceText,targetCode:intent.targetCode,translated:r.text,detectedSource:r.detectedSource};}catch(libreError){throw new Error(`Tarjima serverlari ishlamadi. Google: ${googleError.message}. LibreTranslate: ${libreError.message}`);}}}

// ============================================================
// GEMINI
// ============================================================
async function getSettings(){const rows=await db(`SELECT * FROM settings WHERE id = 1`);return rows[0]||{};}
async function askGemini(userText,history,knowledge){const key=process.env.GEMINI_API_KEY;if(!key)return null;const settings=await getSettings(),model=process.env.GEMINI_MODEL||settings.model||'gemini-2.5-flash',context=knowledge.map((x,i)=>`[QAMIR BILIMI ${i+1}]\nSavol: ${x.question||x.title}\nJavob: ${x.answer}`).join('\n\n');const systemPrompt=`Siz Qamir AI nomli shaxsiy sun'iy intellekt yordamchisisiz.\n\nASOSIY TAMOYIL:\nQamir AI ning asosiy manbasi Admin bergan bilimlardir.\nGemini faqat yordamchi vosita.\n\nAgar mos bilim aniq topilsa, shu bilimga tayaning.\nAgar mos bilim topilmasa, savolga umumiy foydali javob bering.\nBoshqa mavzudagi bilimni foydalanuvchi savoliga mos deb ko‘rsatmang.\nFaktni o‘ylab topmang.\n\nAGENT ROLI:\n${settings.role||''}\n\nASOSIY KO‘RSATMA:\n${settings.instruction||''}\n\nMAJBURIY QOIDALAR:\n${settings.must_rules||''}\n\nTAQIQLAR:\n${settings.never_rules||''}\n\nMIJOZ BILAN MUOMALA:\n${settings.customer_rules||''}\n\nJAVOB USLUBI:\nTil: ${settings.language||'O‘zbek'}\nOhang: ${settings.tone||'Samimiy'}\nEmoji: ${settings.emoji||'some'}\nUzunlik: ${settings.answer_length||'O‘rtacha'}\n\nMUHIM:\nSavolga to‘g‘ridan-to‘g‘ri va tabiiy javob bering.\nBilim matnini to‘liq ko‘chirmang.\nAgar foydalanuvchi hisob-kitob so‘rasa, aniq natija bering.\n\nQAMIR BILIMLARI:\n${context||'(Mos bilim topilmadi.)'}`;const contents=(history||[]).slice(-18).map(m=>({role:m.sender==='assistant'?'model':'user',parts:[{text:String(m.text)}]}));contents.push({role:'user',parts:[{text:String(userText)}]});const response=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({systemInstruction:{parts:[{text:systemPrompt}]},contents,generationConfig:{temperature:Math.max(0,Math.min(2,Number(settings.temperature??0.7))),maxOutputTokens:Math.max(64,Math.min(8192,Number(settings.max_tokens??1024)))}})});const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data?.error?.message||`Gemini HTTP ${response.status}`);return(data?.candidates?.[0]?.content?.parts||[]).map(p=>p.text||'').join('').trim()||null;}

// ============================================================
// HEALTH / AUTH
// ============================================================
app.get('/api/health',async(req,res)=>{try{await db('SELECT 1');res.json({ok:true,database:'connected',gemini:Boolean(process.env.GEMINI_API_KEY),translator:true,weather:true,currency:true,lexuz:true,wikipedia:true,wikidata:true,dictionary:true,smart_search:true,model:process.env.GEMINI_MODEL||'gemini-2.5-flash'});}catch(e){res.status(500).json({ok:false,database:'error',error:e.message});}});
async function register(req,res){try{const{username,email='',password}=req.body||{},un=String(username||'').trim();if(un.length<3||String(password||'').length<6)return res.status(400).json({error:"Login kamida 3, parol kamida 6 belgidan iborat bo'lsin"});const rows=await db(`INSERT INTO users (username,email,password_hash) VALUES ($1,$2,$3) RETURNING id,username,email,birth_date,city,avatar,is_admin,created_at,last_seen`,[un,String(email).trim(),hashPassword(password)]);res.status(201).json({success:true,user:safeUser(rows[0]),token:String(rows[0].id)});}catch(e){if(e.code==='23505')return res.status(409).json({error:'Bu login allaqachon mavjud'});console.error('REGISTER ERROR:',e);res.status(500).json({error:"Ro'yxatdan o'tishda server xatosi"});}}
async function login(req,res){try{const{username,password}=req.body||{},rows=await db(`SELECT id,username,email,birth_date,city,avatar,is_admin,created_at,last_seen FROM users WHERE LOWER(username)=LOWER($1) AND password_hash=$2 LIMIT 1`,[String(username||'').trim(),hashPassword(password||'')]);if(!rows.length)return res.status(401).json({error:"Login yoki parol noto'g'ri"});await db(`UPDATE users SET last_seen=NOW() WHERE id=$1`,[rows[0].id]);res.json({success:true,user:safeUser(rows[0]),token:String(rows[0].id)});}catch(e){console.error('LOGIN ERROR:',e);res.status(500).json({error:'Kirishda server xatosi'});}}
app.post('/api/auth/register',register);app.post('/api/register',register);app.post('/api/auth/login',login);app.post('/api/login',login);app.get('/api/me',requireUser,async(req,res)=>res.json({success:true,user:safeUser(req.user)}));

// ============================================================
// KNOWLEDGE CRUD
// ============================================================
app.get('/api/knowledge',requireUser,async(req,res)=>{try{const rows=await db(`SELECT id,title,question,answer,raw_text AS text,type,enabled,created_at,updated_at FROM knowledge WHERE enabled=TRUE ORDER BY id DESC`);res.json({success:true,knowledge:rows});}catch(e){console.error('KNOWLEDGE GET ERROR:',e);res.status(500).json({error:'Bilimlarni olishda xato'});}});
app.post('/api/knowledge',requireAdmin,async(req,res)=>{try{const{title='',question='',answer='',text='',type='general',enabled=true}=req.body||{},raw=String(text||answer||'').trim();if(!raw)return res.status(400).json({error:"Bilim matni bo'sh"});const rows=await db(`INSERT INTO knowledge (title,question,answer,raw_text,type,enabled) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,title,question,answer,raw_text AS text,type,enabled,created_at,updated_at`,[String(title).trim(),String(question).trim(),String(answer||raw).trim(),raw,String(type),Boolean(enabled)]);res.status(201).json({success:true,knowledge:rows[0]});}catch(e){console.error('KNOWLEDGE ADD ERROR:',e);res.status(500).json({error:'Bilimni saqlashda xato'});}});
app.delete('/api/knowledge/:id',requireAdmin,async(req,res)=>{try{const id=Number(req.params.id);if(!Number.isSafeInteger(id)||id<=0)return res.status(400).json({error:'Bilim ID noto‘g‘ri'});const rows=await db(`DELETE FROM knowledge WHERE id=$1 RETURNING id`,[id]);if(!rows.length)return res.status(404).json({error:'Bilim topilmadi'});res.json({success:true});}catch(e){console.error('KNOWLEDGE DELETE ERROR:',e);res.status(500).json({error:"Bilimni o'chirishda xato"});}});
app.delete('/api/knowledge/all',requireAdmin,async(req,res)=>{try{await db(`TRUNCATE TABLE knowledge RESTART IDENTITY`);res.json({success:true,message:'Barcha bilimlar o‘chirildi'});}catch(e){console.error('KNOWLEDGE DELETE ALL ERROR:',e);res.status(500).json({error:"Barcha bilimlarni o‘chirishda xato"});}});
app.get('/api/admin/knowledge',requireAdmin,async(req,res)=>{const rows=await db(`SELECT id,title,question,answer,raw_text AS text,type,enabled,created_at,updated_at FROM knowledge ORDER BY id DESC`);res.json({success:true,knowledge:rows});});

// ============================================================
// SETTINGS / PROFILE
// ============================================================
app.get('/api/settings',requireAdmin,async(req,res)=>res.json({success:true,settings:await getSettings()}));
app.put('/api/settings',requireAdmin,async(req,res)=>{try{const s=req.body||{};await db(`UPDATE settings SET agent_name=$1,brand_name=$2,role=$3,instruction=$4,must_rules=$5,never_rules=$6,customer_rules=$7,language=$8,tone=$9,emoji=$10,answer_length=$11,greeting=$12,ask_style=$13,model=$14,temperature=$15,max_tokens=$16,updated_at=NOW() WHERE id=1`,[s.agent_name||'Qamir',s.brand_name||'Qamir AI',s.role||'',s.instruction||'',s.must_rules||'',s.never_rules||'',s.customer_rules||'',s.language||'O‘zbek',s.tone||'Samimiy',s.emoji||'some',s.answer_length||'O‘rtacha',s.greeting||'Salom! Men Qamir AI. Sizga qanday yordam beray?',s.ask_style||'',s.model||'gemini-2.5-flash',Number(s.temperature??0.7),Number(s.max_tokens??1024)]);res.json({success:true});}catch(e){console.error('SETTINGS ERROR:',e);res.status(500).json({error:'Sozlamalarni saqlashda xato'});}});
app.put('/api/profile',requireUser,async(req,res)=>{try{const{email='',birth_date='',city='',avatar='',password=''}=req.body||{};if(password&&String(password).length<6)return res.status(400).json({error:'Yangi parol kamida 6 belgi bo\'lsin'});if(password){await db(`UPDATE users SET email=$1,birth_date=$2,city=$3,avatar=$4,password_hash=$5,last_seen=NOW() WHERE id=$6`,[String(email).trim(),String(birth_date),String(city).trim(),String(avatar||'assets/avatar.svg'),hashPassword(password),req.user.id]);}else{await db(`UPDATE users SET email=$1,birth_date=$2,city=$3,avatar=$4,last_seen=NOW() WHERE id=$5`,[String(email).trim(),String(birth_date),String(city).trim(),String(avatar||'assets/avatar.svg'),req.user.id]);}const rows=await db(`SELECT id,username,email,birth_date,city,avatar,is_admin,created_at,last_seen FROM users WHERE id=$1`,[req.user.id]);res.json({success:true,user:safeUser(rows[0])});}catch(e){console.error('PROFILE ERROR:',e);res.status(500).json({error:'Profilni saqlashda xato'});}});

// ============================================================
// CHAT
// ============================================================
app.get('/api/chat/history',requireUser,async(req,res)=>{const rows=await db(`SELECT id,sender,text,created_at FROM messages WHERE user_id=$1 ORDER BY created_at ASC LIMIT 300`,[req.user.id]);res.json({success:true,messages:rows});});
app.post('/api/chat',requireUser,async(req,res)=>{
  try{
    const text=String(req.body?.message||req.body?.text||'').trim();if(!text)return res.status(400).json({error:"Xabar bo'sh"});
    const previous=await db(`SELECT sender,text FROM messages WHERE user_id=$1 ORDER BY created_at DESC LIMIT 40`,[req.user.id]),history=previous.reverse();
    await db(`INSERT INTO messages (user_id,sender,text) VALUES ($1,'user',$2)`,[req.user.id,text]); await db(`UPDATE users SET last_seen=NOW() WHERE id=$1`,[req.user.id]);
    const dateTimeAnswer=getDateTimeAnswer(text);if(dateTimeAnswer){const saved=await db(`INSERT INTO messages (user_id,sender,text) VALUES ($1,'assistant',$2) RETURNING id,sender,text,created_at`,[req.user.id,dateTimeAnswer.answer]);return res.json({success:true,answer:dateTimeAnswer.answer,source:dateTimeAnswer.source,matched_knowledge:[],message:saved[0]});}
    if(looksLikeWeatherQuestion(text)){
      try{
        const weather=await getWeatherAnswer(text,req.user.city);
        if(weather){
          const saved=await db(`INSERT INTO messages (user_id,sender,text) VALUES ($1,'assistant',$2) RETURNING id,sender,text,created_at`,[req.user.id,weather.answer]);
          return res.json({success:true,answer:weather.answer,source:weather.source,matched_knowledge:[],weather:{city:weather.city||null,latitude:weather.latitude||null,longitude:weather.longitude||null},message:saved[0]});
        }
      }catch(e){
        console.error('WEATHER ERROR:',e.message);
        const saved=await db(`INSERT INTO messages (user_id,sender,text) VALUES ($1,'assistant',$2) RETURNING id,sender,text,created_at`,[req.user.id,'Ob-havo xizmati hozircha ishlamadi. Iltimos, birozdan keyin yana urinib ko‘ring.']);
        return res.json({success:true,answer:saved[0].text,source:'weather_error',matched_knowledge:[],message:saved[0]});
      }
    }

    // ========================================================
    // 1. VALYUTA KURSLARI
    // ========================================================

    if (looksLikeCurrencyQuestion(text)) {
      try {
        const currency = await getCurrencyAnswer(text);

        if (currency) {
          const saved = await db(
            `INSERT INTO messages (user_id,sender,text) VALUES ($1,'assistant',$2) RETURNING id,sender,text,created_at`,
            [req.user.id, currency.answer]
          );

          return res.json({
            success: true,
            answer: currency.answer,
            source: currency.source,
            matched_knowledge: [],
            currency: {
              code: currency.currency || null,
              amount: currency.amount ?? null,
              sum: currency.sum ?? null,
              date: currency.date || null
            },
            message: saved[0]
          });
        }
      } catch (e) {
        console.error('CURRENCY ERROR:', e.message);

        const saved = await db(
          `INSERT INTO messages (user_id,sender,text) VALUES ($1,'assistant',$2) RETURNING id,sender,text,created_at`,
          [req.user.id, 'Valyuta kurslari xizmati hozircha javob bermadi. Iltimos, birozdan keyin yana urinib ko‘ring.']
        );

        return res.json({
          success: true,
          answer: saved[0].text,
          source: 'currency_error',
          matched_knowledge: [],
          message: saved[0]
        });
      }
    }

    const calc=tryCalculate(text);if(calc){const saved=await db(`INSERT INTO messages (user_id,sender,text) VALUES ($1,'assistant',$2) RETURNING id,sender,text,created_at`,[req.user.id,calc.answer]);return res.json({success:true,answer:calc.answer,source:'calculator',matched_knowledge:[],calculation:{expression:calc.expression,result:calc.result},message:saved[0]});}
    // ========================================================
    // 3. LUG‘AT
    // ========================================================

    if (looksLikeDictionaryQuestion(text)) {
      try {
        const dictionary = await getDictionaryAnswer(text);
        if (dictionary) {
          const saved = await db(
            `INSERT INTO messages (user_id,sender,text) VALUES ($1,'assistant',$2) RETURNING id,sender,text,created_at`,
            [req.user.id, dictionary.answer]
          );

          return res.json({
            success: true,
            answer: dictionary.answer,
            source: dictionary.source,
            matched_knowledge: [],
            dictionary: {
              word: dictionary.word || null,
              language: dictionary.language || null
            },
            message: saved[0]
          });
        }
      } catch (e) {
        console.error('DICTIONARY ERROR:', e.message);
      }
    }

    const translationRequest=findTranslationIntent(text);
    if(translationRequest){try{const translated=await tryTranslate(text);if(translated){const saved=await db(`INSERT INTO messages (user_id,sender,text) VALUES ($1,'assistant',$2) RETURNING id,sender,text,created_at`,[req.user.id,translated.translated]);return res.json({success:true,answer:translated.translated,source:'translator',matched_knowledge:[],translation:{source_text:translated.sourceText,target_language:translated.targetCode,detected_source_language:translated.detectedSource||null},message:saved[0]});}}catch(e){console.error('TRANSLATOR ERROR:',e.message);const fallback=e.message||'Tarjima xizmati hozircha javob bermadi.';const saved=await db(`INSERT INTO messages (user_id,sender,text) VALUES ($1,'assistant',$2) RETURNING id,sender,text,created_at`,[req.user.id,`Tarjima xizmati hozircha javob bermadi. Iltimos, birozdan keyin yana urinib ko‘ring.`]);return res.json({success:true,answer:saved[0].text,source:'translator_error',error:fallback,matched_knowledge:[],message:saved[0]});}}
    // ========================================================
    // 4. AQLLI QIDIRUV — EXPLICIT WEB BUYRUG‘I USTUVOR
    // ========================================================
    if (looksLikeSmartSearchQuestion(text)) {
      try {
        const search = await getSmartSearchAnswer(text);
        if (search) {
          const saved = await db(
            `INSERT INTO messages (user_id,sender,text) VALUES ($1,'assistant',$2) RETURNING id,sender,text,created_at`,
            [req.user.id, search.answer]
          );
          return res.json({
            success: true,
            answer: search.answer,
            source: search.source,
            matched_knowledge: [],
            query: search.query || cleanSmartSearchQuery(text),
            results: search.results || [],
            message: saved[0]
          });
        }
      } catch (e) {
        console.error('SMART SEARCH ERROR:', e.message);
        const saved = await db(
          `INSERT INTO messages (user_id,sender,text) VALUES ($1,'assistant',$2) RETURNING id,sender,text,created_at`,
          [req.user.id, 'Internet qidiruvi hozircha ishlamadi. Iltimos, birozdan keyin yana urinib ko‘ring.']
        );
        return res.json({success:true,answer:saved[0].text,source:'smart_search_error',matched_knowledge:[],message:saved[0]});
      }
    }

    const matches=await findKnowledge(text,8),trusted=chooseKnowledgeAnswer(matches);let answer=null,source='unknown';if(trusted){answer=String(trusted.answer||'').trim();source='qamir_knowledge';}
    // ========================================================
    // 4. LEXUZ — RASMIY O'ZBEKISTON QONUNCHILIGI
    if (!answer) {
      try {
        const lex = await searchLexUz(text);
        if (lex) {
          answer = lex.answer;
          source = 'lexuz';
        }
      } catch (e) {
        console.error('LEXUZ ERROR:', e.message);
      }
    }

    // 5. WIKIPEDIA
    if (!answer) {
      try {
        const wiki = await searchWikipedia(text);
        if (wiki) {
          const wikiText = [wiki.description, wiki.extract].filter(Boolean).join('\\n\\n').trim();
          if (wikiText) {
            answer = `${wiki.title}\\n\\n${wikiText}`;
            source = 'wikipedia';
          }
        }
      } catch (e) {
        console.error('WIKIPEDIA ERROR:', e);
      }
    }

    // 6. WIKIDATA — FAQAT ISHONCHLI MOSLIK BO'LSA
    if (!answer) {
      try {
        const wikidata = await searchWikidata(text);
        if (wikidata) {
          answer = wikidata.answer;
          source = 'wikidata';
        }
      } catch (e) {
        console.error('WIKIDATA ERROR:', e);
      }
    }

    // 7. GEMINI
    if (!answer) {
      const usefulContext = matches.filter(x => x.score >= 75).slice(0, 4);
      try {
        answer = await askGemini(text, history, usefulContext);
        if (answer) source = 'gemini_assist';
      } catch (e) {
        console.error('GEMINI ERROR:', e.message);
      }
    }
    if(!answer){answer='Bu savol bo‘yicha Qamir AI bilim bazasida hozircha yetarli ma’lumot yo‘q.';source='no_knowledge';}
    const saved=await db(`INSERT INTO messages (user_id,sender,text) VALUES ($1,'assistant',$2) RETURNING id,sender,text,created_at`,[req.user.id,answer]);res.json({success:true,answer,source,matched_knowledge:matches.slice(0,3).map(x=>({id:x.id,title:x.title,question:x.question,score:x.score})),message:saved[0]});
  }catch(e){console.error('CHAT ERROR:',e);res.status(500).json({error:'Chat server xatosi'});}
});

// ============================================================
// ADMIN STATS / IMPROVEMENT
// ============================================================
app.get('/api/admin/stats',requireAdmin,async(req,res)=>{const[m,k,u]=await Promise.all([db(`SELECT COUNT(*)::int AS n FROM messages`),db(`SELECT COUNT(*)::int AS n FROM knowledge WHERE enabled=TRUE`),db(`SELECT COUNT(*)::int AS n FROM users`)]);res.json({success:true,messages:m[0].n,knowledge:k[0].n,users:u[0].n});});
app.get('/api/admin/improve',requireAdmin,async(req,res)=>{const rows=await db(`SELECT id,title,text,status,created_at FROM suggestions WHERE status='pending' ORDER BY id DESC`);res.json({success:true,suggestions:rows});});
app.post('/api/admin/improve/analyze',requireAdmin,async(req,res)=>{const rows=await db(`SELECT text FROM messages WHERE sender='user' ORDER BY id DESC LIMIT 500`),counts=new Map();for(const row of rows){for(const w of tokenize(row.text).filter(x=>x.length>=5))counts.set(w,(counts.get(w)||0)+1);}for(const[topic,count]of[...counts.entries()].sort((a,b)=>b[1]-a[1]).slice(0,10)){if(count<3)continue;const exists=await db(`SELECT id FROM knowledge WHERE LOWER(question||' '||title||' '||answer) LIKE '%'||LOWER($1)||'%' LIMIT 1`,[topic]);if(!exists.length)await db(`INSERT INTO suggestions(title,text) VALUES($1,$2)`,['Ko‘p so‘raladigan mavzu',`Mijozlar “${topic}” mavzusini ${count} marta tilga oldi. Shu mavzu bo‘yicha aniq bilim qo‘shish foydali.`]);}res.json({success:true});});
app.post('/api/admin/improve/:id/approve',requireAdmin,async(req,res)=>{const rows=await db(`SELECT id,title,text FROM suggestions WHERE id=$1 AND status='pending'`,[Number(req.params.id)]);if(!rows.length)return res.status(404).json({error:'Taklif topilmadi'});const s=rows[0];await db(`INSERT INTO knowledge(title,question,answer,raw_text,type) VALUES($1,'',$2,$2,'general')`,[s.title,s.text]);await db(`UPDATE suggestions SET status='approved' WHERE id=$1`,[s.id]);res.json({success:true});});
app.post('/api/admin/improve/:id/reject',requireAdmin,async(req,res)=>{await db(`UPDATE suggestions SET status='rejected' WHERE id=$1`,[Number(req.params.id)]);res.json({success:true});});

app.use(express.static(__dirname));
initDb().then(()=>{app.listen(PORT,'0.0.0.0',()=>{console.log(`Qamir AI server running on port ${PORT}`);console.log('PostgreSQL: connected');console.log(`Gemini API key: ${process.env.GEMINI_API_KEY?'configured':'NOT configured'}`);console.log(`Gemini model: ${process.env.GEMINI_MODEL||'gemini-2.5-flash'}`);console.log('Advanced calculator: enabled');console.log('Translator: Google public + LibreTranslate fallback enabled');console.log('Translator API key: not required');console.log('Uzbekistan date/time: enabled');console.log('Wikipedia search: enabled');console.log('Weather: Open-Meteo enabled (API key not required)');
    console.log('Currency: CBU Uzbekistan official JSON enabled (API key not required)');console.log('LexUZ: official legal search enabled (public pages)');console.log('Wikipedia: Uzbek + English + Russian fallback enabled');console.log('Dictionary: Wiktionary + Free Dictionary API enabled (API key not required)');console.log('Smart search: DuckDuckGo Instant + HTML fallback enabled (API key not required)');console.log('Knowledge search: strict matching enabled');});}).catch(error=>{console.error('DATABASE INIT ERROR:',error);process.exit(1);});
process.on('SIGTERM',async()=>{await pool.end();process.exit(0);});
process.on('SIGINT',async()=>{await pool.end();process.exit(0);});
