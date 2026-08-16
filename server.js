const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();
const PORT = Number(process.env.PORT || 10000);

app.use(cors({
  origin: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use(express.json({ limit: "2mb" }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : false
});

async function db(sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows;
}

function hashPassword(password) {
  return crypto
    .createHash("sha256")
    .update(String(password))
    .digest("hex");
}

function safeUser(row) {
  return {
    id: row.id,
    username: row.username,
    email: row.email || "",
    birth_date: row.birth_date || "",
    city: row.city || "",
    avatar: row.avatar || "assets/avatar.svg",
    is_admin: !!row.is_admin,
    created_at: row.created_at,
    last_seen: row.last_seen
  };
}

async function initDb() {
  console.log("Database tekshirilmoqda...");

  await db(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      email TEXT DEFAULT '',
      password_hash TEXT NOT NULL,
      birth_date TEXT DEFAULT '',
      city TEXT DEFAULT '',
      avatar TEXT DEFAULT 'assets/avatar.svg',
      is_admin BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      last_seen TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await db(`
    CREATE TABLE IF NOT EXISTS knowledge (
      id BIGSERIAL PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      question TEXT DEFAULT '',
      answer TEXT NOT NULL DEFAULT '',
      raw_text TEXT NOT NULL DEFAULT '',
      type TEXT DEFAULT 'general',
      enabled BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await db(`
    CREATE TABLE IF NOT EXISTS messages (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
      sender TEXT NOT NULL CHECK (sender IN ('user','assistant')),
      text TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await db(`
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY DEFAULT 1,
      agent_name TEXT DEFAULT 'Qamir',
      brand_name TEXT DEFAULT 'Qamir AI',
      role TEXT DEFAULT '',
      instruction TEXT DEFAULT '',
      must_rules TEXT DEFAULT '',
      never_rules TEXT DEFAULT '',
      customer_rules TEXT DEFAULT '',
      language TEXT DEFAULT 'O‘zbek',
      tone TEXT DEFAULT 'Samimiy',
      emoji TEXT DEFAULT 'some',
      answer_length TEXT DEFAULT 'O‘rtacha',
      greeting TEXT DEFAULT 'Salom! Men Qamir AI. Sizga qanday yordam beray?',
      ask_style TEXT DEFAULT '',
      model TEXT DEFAULT 'gemini-2.5-flash',
      temperature NUMERIC DEFAULT 0.7,
      max_tokens INTEGER DEFAULT 1024,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await db(`
    CREATE TABLE IF NOT EXISTS suggestions (
      id BIGSERIAL PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  const setting = await db(
    `SELECT id FROM settings WHERE id = 1`
  );

  if (!setting.length) {
    await db(
      `INSERT INTO settings (id) VALUES (1)`
    );
  }

  const adminPassword =
    process.env.ADMIN_PASSWORD || "Al-qamir";

  const adminHash =
    hashPassword(adminPassword);

  const adminRows =
    await db(
      `SELECT id FROM users
       WHERE LOWER(username) = 'admin'
       LIMIT 1`
    );

  if (!adminRows.length) {
    await db(
      `INSERT INTO users
       (username, email, password_hash, is_admin)
       VALUES ('Admin', 'admin@qamir.ai', $1, TRUE)`,
      [adminHash]
    );

    console.log("Admin account yaratildi.");
  } else {
    await db(
      `UPDATE users
       SET password_hash = $1,
           is_admin = TRUE
       WHERE LOWER(username) = 'admin'`,
      [adminHash]
    );

    console.log("Admin account yangilandi.");
  }

  console.log("Database tayyor.");
}

function bearer(req) {
  const h =
    req.headers.authorization || "";

  return h.startsWith("Bearer ")
    ? h.slice(7)
    : "";
}

async function userFromRequest(req) {
  const token = bearer(req);

  if (!token) return null;

  const id = Number(token);

  if (
    !Number.isSafeInteger(id) ||
    id <= 0
  ) {
    return null;
  }

  const rows =
    await db(
      `SELECT id, username, email, birth_date, city, avatar,
              is_admin, created_at, last_seen
       FROM users
       WHERE id = $1
       LIMIT 1`,
      [id]
    );

  return rows[0] || null;
}

async function requireUser(req, res, next) {
  try {
    const user =
      await userFromRequest(req);

    if (!user) {
      return res.status(401).json({
        error:
          "Kirish talab qilinadi"
      });
    }

    req.user = user;
    next();
  } catch (e) {
    console.error(
      "AUTH ERROR:",
      e
    );

    res.status(500).json({
      error:
        "Server xatosi"
    });
  }
}

async function requireAdmin(req, res, next) {
  try {
    const user =
      await userFromRequest(req);

    if (
      !user ||
      !user.is_admin
    ) {
      return res.status(403).json({
        error:
          "Faqat Admin uchun"
      });
    }

    req.user = user;
    next();
  } catch (e) {
    console.error(
      "ADMIN ERROR:",
      e
    );

    res.status(500).json({
      error:
        "Server xatosi"
    });
  }
}

// ============================================================
// KNOWLEDGE SEARCH
// ============================================================

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[ʻ’‘`´']/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STOP_WORDS = new Set([
  "qanaqa",
  "qanaqib",
  "qanday",
  "qaysi",
  "qayer",
  "qayerda",
  "qayerdan",
  "qayeriga",
  "nima",
  "nega",
  "qilib",
  "qilish",
  "kerak",
  "mumkin",
  "menga",
  "manga",
  "man",
  "men",
  "siz",
  "uchun",
  "bilan",
  "dan",
  "ga",
  "ka",
  "qa",
  "ni",
  "ning",
  "da",
  "de",
  "bo‘yicha",
  "boyicha",
  "shu",
  "bu",
  "bir",
  "bor",
  "yoq",
  "yo‘q",
  "ochaman",
  "ochsam",
  "qilaman",
  "qilay",
  "qilsa",
  "qilsam",
  "ber",
  "berish",
  "olish",
  "olaman",
  "mi",
  "mu",
  "edi",
  "ekan",
  "bo‘ladi",
  "boladi",
  "chi",
  "endi"
]);

function stem(word) {
  let w =
    String(word || "");

  if (!w) return "";

  const suffixes = [
    "laringiz",
    "laring",
    "ingiz",
    "imiz",
    "ning",
    "dan",
    "den",
    "dagi",
    "ga",
    "ka",
    "qa",
    "ni",
    "da",
    "de",
    "lar",
    "lik",
    "li",
    "siz",
    "man",
    "men"
  ];

  for (
    const suffix
    of suffixes
  ) {
    if (
      w.length >
        suffix.length + 2 &&
      w.endsWith(suffix)
    ) {
      w =
        w.slice(
          0,
          -suffix.length
        );

      break;
    }
  }

  if (
    w === "worddan" ||
    w === "word" ||
    w === "vord"
  ) {
    return "word";
  }

  if (
    w === "eksel" ||
    w === "excel"
  ) {
    return "excel";
  }

  if (
    w === "powerpoint" ||
    w === "ppt"
  ) {
    return "powerpoint";
  }

  if (
    w === "telegram"
  ) {
    return "telegram";
  }

  if (
    w === "instagram" ||
    w === "insta"
  ) {
    return "instagram";
  }

  if (
    w === "telefon" ||
    w === "tel"
  ) {
    return "telefon";
  }

  return w;
}

function tokenize(
  text,
  options = {}
) {
  const removeStop =
    options.removeStop !== false;

  return [
    ...new Set(
      normalize(text)
        .split(/\s+/)
        .map(stem)
        .filter(
          w => w.length >= 2
        )
        .filter(
          w =>
            !removeStop ||
            !STOP_WORDS.has(w)
        )
    )
  ];
}

function tokenizeRaw(text) {
  return [
    ...new Set(
      normalize(text)
        .split(/\s+/)
        .map(stem)
        .filter(Boolean)
    )
  ];
}

function phraseIncludes(
  text,
  phrase
) {
  const a =
    ` ${normalize(text)} `;

  const b =
    ` ${normalize(phrase)} `;

  return a.includes(b);
}

function overlapCount(
  queryWords,
  targetText
) {
  const targetWords =
    tokenizeRaw(targetText);

  const set =
    new Set(targetWords);

  let count = 0;

  for (
    const q
    of queryWords
  ) {
    if (set.has(q)) {
      count++;
      continue;
    }

    if (
      q.length >= 4 &&
      targetWords.some(
        t =>
          t === q ||
          t.startsWith(q) ||
          q.startsWith(t)
      )
    ) {
      count++;
    }
  }

  return count;
}

function extractAlternativeQuestions(
  rawText
) {
  const text =
    String(rawText || "");

  const m =
    text.match(
      /Muqobil\s+savollar\s*:\s*([\s\S]*?)(?=\n\s*Javob\s*:|$)/i
    );

  if (!m) return [];

  return m[1]
    .split(/[;|]/)
    .map(
      x => x.trim()
    )
    .filter(Boolean);
}

function levenshtein(
  a,
  b
) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  if (
    Math.abs(
      a.length - b.length
    ) > 2
  ) {
    return 99;
  }

  const prev =
    new Array(
      b.length + 1
    );

  const cur =
    new Array(
      b.length + 1
    );

  for (
    let j = 0;
    j <= b.length;
    j++
  ) {
    prev[j] = j;
  }

  for (
    let i = 1;
    i <= a.length;
    i++
  ) {
    cur[0] = i;

    for (
      let j = 1;
      j <= b.length;
      j++
    ) {
      const cost =
        a[i - 1] === b[j - 1]
          ? 0
          : 1;

      cur[j] =
        Math.min(
          cur[j - 1] + 1,
          prev[j] + 1,
          prev[j - 1] + cost
        );
    }

    for (
      let j = 0;
      j <= b.length;
      j++
    ) {
      prev[j] = cur[j];
    }
  }

  return prev[b.length];
}

function scoreKnowledge(
  query,
  item
) {
  const normalizedQuery =
    normalize(query);

  const qWords =
    tokenize(query, {
      removeStop: true
    });

  if (
    !normalizedQuery ||
    !qWords.length
  ) {
    return 0;
  }

  const question =
    normalize(
      item.question || ""
    );

  const title =
    normalize(
      item.title || ""
    );

  const answer =
    normalize(
      item.answer || ""
    );

  const rawText =
    normalize(
      item.raw_text || ""
    );

  const alternatives =
    extractAlternativeQuestions(
      item.raw_text || ""
    );

  let score = 0;

  if (
    question &&
    normalizedQuery === question
  ) {
    score += 180;
  }

  for (
    const alt
    of alternatives
  ) {
    const altNorm =
      normalize(alt);

    if (
      normalizedQuery === altNorm
    ) {
      score += 180;
    } else if (
      phraseIncludes(
        normalizedQuery,
        alt
      ) ||
      phraseIncludes(
        alt,
        normalizedQuery
      )
    ) {
      score += 130;
    }
  }

  const questionHits =
    overlapCount(
      qWords,
      question
    );

  const titleHits =
    overlapCount(
      qWords,
      title
    );

  const altHits =
    alternatives.reduce(
      (best, alt) =>
        Math.max(
          best,
          overlapCount(
            qWords,
            alt
          )
        ),
      0
    );

  const strongestHits =
    Math.max(
      questionHits,
      titleHits,
      altHits
    );

  const queryCount =
    Math.max(
      qWords.length,
      1
    );

  const coverage =
    strongestHits /
    queryCount;

  score +=
    questionHits * 32;

  score +=
    titleHits * 20;

  score +=
    altHits * 45;

  if (
    question &&
    (
      normalizedQuery.includes(
        question
      ) ||
      question.includes(
        normalizedQuery
      )
    )
  ) {
    score += 110;
  }

  if (
    title &&
    normalizedQuery.includes(
      title
    )
  ) {
    score += 80;
  }

  const answerHits =
    overlapCount(
      qWords,
      answer
    );

  const rawHits =
    overlapCount(
      qWords,
      rawText
    );

  score +=
    Math.min(
      answerHits,
      2
    ) * 2;

  score +=
    Math.min(
      rawHits,
      2
    );

  for (
    const q
    of qWords
  ) {
    if (q.length < 4) {
      continue;
    }

    const candidates = [
      question,
      title,
      ...alternatives
    ]
      .join(" ")
      .split(/\s+/);

    if (
      candidates.some(
        c =>
          c.length >= 4 &&
          levenshtein(
            q,
            c
          ) <= 1
      )
    ) {
      score += 8;
    }
  }

  if (
    qWords.length === 1 &&
    strongestHits === 0
  ) {
    return 0;
  }

  if (
    qWords.length >= 2 &&
    coverage < 0.34
  ) {
    return 0;
  }

  return Math.round(score);
}

async function findKnowledge(
  query,
  limit = 8
) {
  const rows =
    await db(`
      SELECT
        id,
        title,
        question,
        answer,
        raw_text,
        type,
        enabled
      FROM knowledge
      WHERE enabled = TRUE
      ORDER BY id DESC
    `);

  return rows
    .map(
      item => ({
        ...item,
        score:
          scoreKnowledge(
            query,
            item
          )
      })
    )
    .filter(
      item =>
        item.score >= 55
    )
    .sort(
      (a, b) =>
        b.score - a.score
    )
    .slice(
      0,
      limit
    );
}

function chooseKnowledgeAnswer(
  matches
) {
  if (!matches.length) {
    return null;
  }

  const best =
    matches[0];

  if (
    best.score >= 120
  ) {
    return best;
  }

  if (
    best.score >= 90 &&
    matches.length === 1
  ) {
    return best;
  }

  if (
    best.score >= 75
  ) {
    const second =
      matches[1];

    if (
      !second ||
      best.score -
        second.score >= 15
    ) {
      return best;
    }
  }

  return null;
}

// ============================================================
// DATE / TIME - O'ZBEKISTON
// ============================================================

function getUzbekistanDateTime() {
  const now =
    new Date();

  const dateParts =
    new Intl.DateTimeFormat(
      "uz-UZ",
      {
        timeZone:
          "Asia/Tashkent",
        year:
          "numeric",
        month:
          "2-digit",
        day:
          "2-digit"
      }
    ).formatToParts(
      now
    );

  const timeParts =
    new Intl.DateTimeFormat(
      "uz-UZ",
      {
        timeZone:
          "Asia/Tashkent",
        hour:
          "2-digit",
        minute:
          "2-digit",
        second:
          "2-digit",
        hour12:
          false
      }
    ).formatToParts(
      now
    );

  const weekday =
    new Intl.DateTimeFormat(
      "uz-UZ",
      {
        timeZone:
          "Asia/Tashkent",
        weekday:
          "long"
      }
    ).format(now);

  function part(
    parts,
    type
  ) {
    return (
      parts.find(
        x => x.type === type
      )?.value || ""
    );
  }

  return {
    year:
      part(
        dateParts,
        "year"
      ),
    month:
      part(
        dateParts,
        "month"
      ),
    day:
      part(
        dateParts,
        "day"
      ),
    hour:
      part(
        timeParts,
        "hour"
      ),
    minute:
      part(
        timeParts,
        "minute"
      ),
    second:
      part(
        timeParts,
        "second"
      ),
    weekday
  };
}

function getDateTimeAnswer(
  text
) {
  const q =
    normalize(text);

  const datePatterns = [
    "bugun nechi",
    "bugun sana",
    "bugungi sana",
    "bugun nechanchi",
    "sana nechi",
    "bugun qaysi kun",
    "bugun nima kun",
    "bugun haftaning qaysi kuni",
    "bugun nechanchi sana"
  ];

  const timePatterns = [
    "soat nechi",
    "hozir soat nechi",
    "hozirgi vaqt",
    "vaqt nechi",
    "hozir nechi",
    "hozir soat"
  ];

  const asksDate =
    datePatterns.some(
      pattern =>
        q.includes(pattern)
    );

  const asksTime =
    timePatterns.some(
      pattern =>
        q.includes(pattern)
    );

  if (
    !asksDate &&
    !asksTime
  ) {
    return null;
  }

  const d =
    getUzbekistanDateTime();

  if (
    asksTime &&
    !asksDate
  ) {
    return {
      answer:
        `Hozir O‘zbekiston vaqti bilan soat ${d.hour}:${d.minute}:${d.second}.`,
      source:
        "date_time"
    };
  }

  if (
    asksDate &&
    asksTime
  ) {
    return {
      answer:
        `Bugun ${d.day}.${d.month}.${d.year}, ${d.weekday}. Hozir soat ${d.hour}:${d.minute}:${d.second}.`,
      source:
        "date_time"
    };
  }

  return {
    answer:
      `Bugun ${d.day}.${d.month}.${d.year}, ${d.weekday}.`,
    source:
      "date_time"
  };
}

// ============================================================
// WIKIPEDIA
// ============================================================

function cleanWikipediaQuery(
  text
) {
  let q =
    String(text || "")
      .trim()
      .replace(
        /[?!.]+$/g,
        ""
      )
      .replace(
        /\b(?:kim|kimdir|haqida|togrisida|to'g'risida|biografiya|tarjimai holi)\b/gi,
        " "
      )
      .replace(
        /\s+/g,
        " "
      )
      .trim();

  return q;
}

function looksLikeWikipediaQuestion(
  text
) {
  const q =
    normalize(text);

  if (
    !q ||
    q.length < 2
  ) {
    return false;
  }

  const explicitPatterns = [
    /\bkim\b/i,
    /\bkimdir\b/i,
    /\bhaqida\b/i,
    /\btogrisida\b/i,
    /\bbiografiya\b/i,
    /\btarjimai holi\b/i,
    /\bkim yaratgan\b/i,
    /\bkim asos solgan\b/i,
    /\bkim ixtiro qilgan\b/i,
    /\bqachon vafot etgan\b/i,
    /\bqachon tugilgan\b/i,
    /\bqayerda tugilgan\b/i
  ];

  return explicitPatterns.some(
    pattern =>
      pattern.test(q)
  );
}

function cleanWikipediaHtml(
  text
) {
  return String(text || "")
    .replace(
      /<br\s*\/?>/gi,
      "\n"
    )
    .replace(
      /<span[^>]*>/gi,
      ""
    )
    .replace(
      /<\/span>/gi,
      ""
    )
    .replace(
      /<[^>]*>/g,
      ""
    )
    .replace(
      /&quot;/g,
      '"'
    )
    .replace(
      /&#039;/g,
      "'"
    )
    .replace(
      /&#39;/g,
      "'"
    )
    .replace(
      /&amp;/g,
      "&"
    )
    .replace(
      /&lt;/g,
      "<"
    )
    .replace(
      /&gt;/g,
      ">"
    )
    .replace(
      /&#160;/g,
      " "
    )
    .replace(
      /\s+\n/g,
      "\n"
    )
    .replace(
      /\n\s+/g,
      "\n"
    )
    .replace(
      /[ \t]+/g,
      " "
    )
    .trim();
}

function scoreWikipediaTitle(
  query,
  title
) {
  const qWords =
    tokenizeRaw(query)
      .filter(
        w => w.length >= 2
      );

  const tWords =
    tokenizeRaw(title)
      .filter(
        w => w.length >= 2
      );

  if (
    !qWords.length ||
    !tWords.length
  ) {
    return 0;
  }

  let score = 0;
  let matched = 0;

  for (
    const qw
    of qWords
  ) {
    let best = 0;

    for (
      const tw
      of tWords
    ) {
      if (
        qw === tw
      ) {
        best =
          Math.max(
            best,
            100
          );
      } else if (
        qw.startsWith(tw) ||
        tw.startsWith(qw)
      ) {
        best =
          Math.max(
            best,
            72
          );
      } else {
        const distance =
          levenshtein(
            qw,
            tw
          );

        if (
          distance === 1
        ) {
          best =
            Math.max(
              best,
              65
            );
        } else if (
          distance === 2
        ) {
          best =
            Math.max(
              best,
              48
            );
        } else if (
          distance === 3
        ) {
          best =
            Math.max(
              best,
              25
            );
        }
      }
    }

    if (
      best > 0
    ) {
      matched++;
      score += best;
    }
  }

  const coverage =
    matched /
    Math.max(
      qWords.length,
      1
    );

  score +=
    coverage * 80;

  if (
    normalize(title) ===
    normalize(query)
  ) {
    score += 250;
  }

  return score;
}

async function wikipediaSearchRaw(
  language,
  query,
  limit = 10
) {
  const base =
    `https://${language}.wikipedia.org`;

  const url =
    `${base}/w/api.php` +
    `?action=query` +
    `&list=search` +
    `&srsearch=${encodeURIComponent(query)}` +
    `&srnamespace=0` +
    `&srlimit=${Math.min(
      50,
      Math.max(1, limit)
    )}` +
    `&srprop=snippet|titlesnippet|sectiontitle|categorysnippet` +
    `&format=json` +
    `&formatversion=2` +
    `&origin=*`;

  const response =
    await fetch(
      url,
      {
        method: "GET",
        headers: {
          "User-Agent":
            "QamirAI/1.0 (Qamir AI personal assistant; contact: admin@qamir.ai)",
          "Api-User-Agent":
            "QamirAI/1.0 (Qamir AI personal assistant)"
        }
      }
    );

  if (!response.ok) {
    const body =
      await response
        .text()
        .catch(
          () => ""
        );

    console.error(
      `Wikipedia ${language} HTTP ${response.status}:`,
      body.slice(
        0,
        500
      )
    );

    return {
      pages: [],
      suggestion: ""
    };
  }

  const data =
    await response
      .json()
      .catch(
        () => ({})
      );

  const pages =
    Array.isArray(
      data?.query?.search
    )
      ? data.query.search.map(
          item => ({
            title:
              item?.title ||
              "",
            pageid:
              item?.pageid ||
              null,
            snippet:
              cleanWikipediaHtml(
                item?.snippet ||
                ""
              )
          })
        )
      : [];

  const suggestion =
    String(
      data?.query?.searchinfo
        ?.suggestion ||
      ""
    ).trim();

  return {
    pages,
    suggestion
  };
}

async function wikipediaGetPage(
  language,
  title
) {
  const base =
    `https://${language}.wikipedia.org`;

  const url =
    `${base}/w/api.php` +
    `?action=query` +
    `&prop=extracts|info` +
    `&exintro=1` +
    `&explaintext=1` +
    `&exchars=4000` +
    `&inprop=url` +
    `&redirects=1` +
    `&titles=${encodeURIComponent(title)}` +
    `&format=json` +
    `&formatversion=2` +
    `&origin=*`;

  const response =
    await fetch(
      url,
      {
        method: "GET",
        headers: {
          "User-Agent":
            "QamirAI/1.0 (Qamir AI personal assistant; contact: admin@qamir.ai)",
          "Api-User-Agent":
            "QamirAI/1.0 (Qamir AI personal assistant)"
        }
      }
    );

  if (!response.ok) {
    const body =
      await response
        .text()
        .catch(
          () => ""
        );

    console.error(
      `Wikipedia page ${language} HTTP ${response.status}:`,
      body.slice(
        0,
        500
      )
    );

    return null;
  }

  const data =
    await response
      .json()
      .catch(
        () => ({})
      );

  const page =
    Array.isArray(
      data?.query?.pages
    )
      ? data.query.pages[0]
      : null;

  if (
    !page ||
    page.missing
  ) {
    return null;
  }

  const extract =
    cleanWikipediaHtml(
      page.extract ||
      ""
    );

  if (!extract) {
    return null;
  }

  return {
    title:
      String(
        page.title ||
        title
      ).trim(),
    extract,
    url:
      String(
        page.fullurl ||
        ""
      ).trim()
  };
}

function makeWikipediaVariants(
  query,
  suggestion = ""
) {
  const variants = [];
  const seen = new Set();

  function add(value) {
    const v =
      String(value || "")
        .trim()
        .replace(
          /\s+/g,
          " "
        );

    if (
      v.length < 2 ||
      seen.has(
        v.toLowerCase()
      )
    ) {
      return;
    }

    seen.add(
      v.toLowerCase()
    );

    variants.push(v);
  }

  add(query);
  add(suggestion);

  const wordsList =
    tokenizeRaw(query)
      .filter(
        w => w.length >= 3
      );

  if (
    wordsList.length > 1
  ) {
    add(
      wordsList.join(" ")
    );
  }

  for (
    const word
    of wordsList
  ) {
    add(word);
  }

  return variants.slice(
    0,
    8
  );
}

async function fetchWikipediaFromLanguage(
  language,
  query
) {
  try {
    console.log(
      `Wikipedia qidiruvi [${language}]:`,
      query
    );

    const first =
      await wikipediaSearchRaw(
        language,
        query,
        10
      );

    let allPages = [
      ...(first.pages || [])
    ];

    const variants =
      makeWikipediaVariants(
        query,
        first.suggestion
      );

    if (
      first.suggestion &&
      first.suggestion.toLowerCase() !==
        query.toLowerCase()
    ) {
      try {
        const suggested =
          await wikipediaSearchRaw(
            language,
            first.suggestion,
            10
          );

        allPages.push(
          ...(suggested.pages || [])
        );
      } catch (e) {
        console.error(
          "Wikipedia suggestion search error:",
          e.message
        );
      }
    }

    if (
      allPages.length < 3
    ) {
      for (
        const variant
        of variants.slice(
          0,
          5
        )
      ) {
        if (
          normalize(variant) ===
          normalize(query)
        ) {
          continue;
        }

        try {
          const result =
            await wikipediaSearchRaw(
              language,
              variant,
              10
            );

          allPages.push(
            ...(result.pages || [])
          );
        } catch (e) {
          console.error(
            "Wikipedia fallback search error:",
            e.message
          );
        }
      }
    }

    const uniquePages = [];
    const seenTitles =
      new Set();

    for (
      const item
      of allPages
    ) {
      const title =
        String(
          item?.title || ""
        ).trim();

      const titleKey =
        normalize(title);

      if (
        !title ||
        !titleKey ||
        seenTitles.has(
          titleKey
        )
      ) {
        continue;
      }

      seenTitles.add(
        titleKey
      );

      uniquePages.push(
        item
      );
    }

    if (
      !uniquePages.length
    ) {
      return null;
    }

    let bestPage = null;
    let bestScore = -1;

    for (
      const candidate
      of uniquePages
    ) {
      const title =
        String(
          candidate?.title ||
          ""
        ).trim();

      const score =
        scoreWikipediaTitle(
          query,
          title
        );

      if (
        score > bestScore
      ) {
        bestScore = score;
        bestPage = candidate;
      }
    }

    if (
      !bestPage ||
      bestScore < 70
    ) {
      console.log(
        `Wikipedia [${language}]: mos keluvchi sahifa topilmadi. Eng yaxshi score=${bestScore}`
      );

      return null;
    }

    const page =
      await wikipediaGetPage(
        language,
        bestPage.title
      );

    if (!page) {
      return null;
    }

    console.log(
      `Wikipedia topildi [${language}]:`,
      page.title,
      `score=${bestScore}`
    );

    return {
      language,
      title:
        page.title,
      description:
        "",
      extract:
        page.extract,
      url:
        page.url
    };

  } catch (error) {
    console.error(
      `WIKIPEDIA ${language.toUpperCase()} ERROR:`,
      error.message
    );

    return null;
  }
}

async function searchWikipedia(
  userText
) {
  if (
    !looksLikeWikipediaQuestion(
      userText
    )
  ) {
    return null;
  }

  const query =
    cleanWikipediaQuery(
      userText
    );

  if (
    !query ||
    query.length < 2
  ) {
    return null;
  }

  console.log(
    "Wikipedia yakuniy query:",
    query
  );

  let result =
    await fetchWikipediaFromLanguage(
      "uz",
      query
    );

  if (!result) {
    result =
      await fetchWikipediaFromLanguage(
        "en",
        query
      );
  }

  return result;
}

// ============================================================
// ADVANCED CALCULATOR
// ============================================================

function formatNumber(
  value
) {
  if (
    Object.is(
      value,
      -0
    )
  ) {
    value = 0;
  }

  if (
    Number.isInteger(value)
  ) {
    return String(value);
  }

  return Number(
    value.toFixed(12)
  ).toLocaleString(
    "uz-UZ",
    {
      maximumFractionDigits: 12,
      useGrouping: false
    }
  );
}

function factorial(n) {
  n = Number(n);

  if (
    !Number.isInteger(n) ||
    n < 0 ||
    n > 170
  ) {
    throw new Error(
      "Faktorial uchun 0 dan 170 gacha butun son kerak."
    );
  }

  let result = 1;

  for (
    let i = 2;
    i <= n;
    i++
  ) {
    result *= i;
  }

  return result;
}

function degToRad(x) {
  return (
    x *
    Math.PI /
    180
  );
}

function radToDeg(x) {
  return (
    x *
    180 /
    Math.PI
  );
}

function normalizeMathQuestion(
  text
) {
  let q =
    String(text || "")
      .trim()
      .toLowerCase()
      .replace(
        /[ʻ’‘`´]/g,
        ""
      )
      .replace(
        /[−–—]/g,
        "-"
      )
      .replace(
        /[×✕]/g,
        "*"
      )
      .replace(
        /÷/g,
        "/"
      )
      .replace(
        /\s+/g,
        " "
      );

  const hasFunctionArguments =
    /[a-zA-Z]+\s*\([^)]*,/.test(q);

  if (
    !hasFunctionArguments
  ) {
    q =
      q.replace(
        /(\d)\s*,\s*(\d)/g,
        "$1.$2"
      );
  }

  return q;
}

function calculatePercentage(
  text
) {
  const q =
    normalizeMathQuestion(
      text
    )
      .replace(
        /\?+$/g,
        ""
      )
      .trim();

  let m;

  m =
    q.match(
      /^(-?\d+(?:\.\d+)?)\s*ning\s+(-?\d+(?:\.\d+)?)\s*(?:foiz|foizi|foizini|%)\s*(?:qancha|necha|bo'ladi|boladi)?$/i
    );

  if (m) {
    const base =
      Number(m[1]);

    const percent =
      Number(m[2]);

    const result =
      base *
      percent /
      100;

    return {
      answer:
        `${formatNumber(base)} ning ${formatNumber(percent)}% = ${formatNumber(result)}`,
      result
    };
  }

  m =
    q.match(
      /^(?:hisobla|hisoblab\s+ber|top|aniqla)\s+(-?\d+(?:\.\d+)?)\s*ning\s+(-?\d+(?:\.\d+)?)\s*(?:foiz|foizi|foizini|%)$/i
    );

  if (m) {
    const base =
      Number(m[1]);

    const percent =
      Number(m[2]);

    const result =
      base *
      percent /
      100;

    return {
      answer:
        `${formatNumber(base)} ning ${formatNumber(percent)}% = ${formatNumber(result)}`,
      result
    };
  }

  m =
    q.match(
      /^(-?\d+(?:\.\d+)?)\s*(?:foiz|foizi|foizini|%)\s+(?:ning\s+)?(-?\d+(?:\.\d+)?)(?:\s+dan)?$/i
    );

  if (m) {
    const percent =
      Number(m[1]);

    const base =
      Number(m[2]);

    const result =
      base *
      percent /
      100;

    return {
      answer:
        `${formatNumber(percent)}% ${formatNumber(base)} ning = ${formatNumber(result)}`,
      result
    };
  }

  m =
    q.match(
      /^(-?\d+(?:\.\d+)?)\s*%\s*(?:of|dan|ning)\s*(-?\d+(?:\.\d+)?)$/i
    );

  if (m) {
    const percent =
      Number(m[1]);

    const base =
      Number(m[2]);

    const result =
      base *
      percent /
      100;

    return {
      answer:
        `${formatNumber(percent)}% of ${formatNumber(base)} = ${formatNumber(result)}`,
      result
    };
  }

  m =
    q.match(
      /^(-?\d+(?:\.\d+)?)\s+dan\s+(-?\d+(?:\.\d+)?)\s*%\s*(?:ayir|ayirish|kamaytir|kamaytirish)$/i
    );

  if (m) {
    const base =
      Number(m[1]);

    const percent =
      Number(m[2]);

    const result =
      base -
      (
        base *
        percent /
        100
      );

    return {
      answer:
        `${formatNumber(base)} dan ${formatNumber(percent)}% ayirilsa = ${formatNumber(result)}`,
      result
    };
  }

  m =
    q.match(
      /^(-?\d+(?:\.\d+)?)\s+ga\s+(-?\d+(?:\.\d+)?)\s*%\s*(?:qo'sh|qosh|qo'shish|qoshish|oshir|oshirish)$/i
    );

  if (m) {
    const base =
      Number(m[1]);

    const percent =
      Number(m[2]);

    const result =
      base +
      (
        base *
        percent /
        100
      );

    return {
      answer:
        `${formatNumber(base)} ga ${formatNumber(percent)}% qo‘shilsa = ${formatNumber(result)}`,
      result
    };
  }

  m =
    q.match(
      /^(-?\d+(?:\.\d+)?)\s*([+-])\s*(-?\d+(?:\.\d+)?)\s*%$/
    );

  if (m) {
    const base =
      Number(m[1]);

    const op =
      m[2];

    const percent =
      Number(m[3]);

    const delta =
      base *
      percent /
      100;

    const result =
      op === "+"
        ? base + delta
        : base - delta;

    return {
      answer:
        `${formatNumber(base)} ${op} ${formatNumber(percent)}% = ${formatNumber(result)}`,
      result
    };
  }

  return null;
}

function tokenizeMathExpression(
  expression
) {
  const tokens = [];
  let i = 0;

  while (
    i <
    expression.length
  ) {
    const ch =
      expression[i];

    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    if (
      /[0-9.]/.test(ch)
    ) {
      const start =
        i;

      let dotCount = 0;

      while (
        i <
          expression.length &&
        /[0-9.]/.test(
          expression[i]
        )
      ) {
        if (
          expression[i] ===
          "."
        ) {
          dotCount++;
        }

        i++;
      }

      const raw =
        expression.slice(
          start,
          i
        );

      if (
        dotCount > 1 ||
        raw === "."
      ) {
        throw new Error(
          "Noto‘g‘ri son"
        );
      }

      const value =
        Number(raw);

      if (
        !Number.isFinite(
          value
        )
      ) {
        throw new Error(
          "Noto‘g‘ri son"
        );
      }

      tokens.push({
        type:
          "number",
        value
      });

      continue;
    }

    if (
      /[a-zA-Z]/.test(ch)
    ) {
      const start =
        i;

      while (
        i <
          expression.length &&
        /[a-zA-Z]/.test(
          expression[i]
        )
      ) {
        i++;
      }

      tokens.push({
        type:
          "identifier",
        value:
          expression
            .slice(
              start,
              i
            )
            .toLowerCase()
      });

      continue;
    }

    if (
      ch === "+" ||
      ch === "-" ||
      ch === "*" ||
      ch === "/" ||
      ch === "%" ||
      ch === "^" ||
      ch === "(" ||
      ch === ")" ||
      ch === "," ||
      ch === "!"
    ) {
      tokens.push({
        type: ch,
        value: ch
      });

      i++;
      continue;
    }

    throw new Error(
      "Noma’lum matematik belgi"
    );
  }

  return tokens;
}

function evaluateAdvancedExpression(
  expression
) {
  const tokens =
    tokenizeMathExpression(
      expression
    );

  let pos = 0;

  const constants = {
    pi:
      Math.PI,
    e:
      Math.E
  };

  const functions = {
    sqrt:
      x => Math.sqrt(x),

    abs:
      x => Math.abs(x),

    floor:
      x => Math.floor(x),

    ceil:
      x => Math.ceil(x),

    round:
      x => Math.round(x),

    sin:
      x => Math.sin(
        degToRad(x)
      ),

    cos:
      x => Math.cos(
        degToRad(x)
      ),

    tan:
      x => Math.tan(
        degToRad(x)
      ),

    asin:
      x => radToDeg(
        Math.asin(x)
      ),

    acos:
      x => radToDeg(
        Math.acos(x)
      ),

    atan:
      x => radToDeg(
        Math.atan(x)
      ),

    ln:
      x => Math.log(x),

    log:
      x => Math.log10(x),

    exp:
      x => Math.exp(x),

    pow:
      (a, b) =>
        Math.pow(a, b),

    min:
      (...args) =>
        Math.min(...args),

    max:
      (...args) =>
        Math.max(...args),

    fact:
      factorial
  };

  function ensureFinite(
    value
  ) {
    if (
      typeof value !==
        "number" ||
      !Number.isFinite(
        value
      )
    ) {
      throw new Error(
        "Matematik natija yaroqsiz"
      );
    }

    return value;
  }

  function parseExpression() {
    let value =
      parseTerm();

    while (
      pos <
        tokens.length &&
      (
        tokens[pos].type ===
          "+" ||
        tokens[pos].type ===
          "-"
      )
    ) {
      const op =
        tokens[pos++].type;

      const right =
        parseTerm();

      value =
        op === "+"
          ? value + right
          : value - right;

      ensureFinite(
        value
      );
    }

    return value;
  }

  function parseTerm() {
    let value =
      parsePower();

    while (
      pos <
        tokens.length &&
      (
        tokens[pos].type ===
          "*" ||
        tokens[pos].type ===
          "/" ||
        tokens[pos].type ===
          "%"
      )
    ) {
      const op =
        tokens[pos++].type;

      const right =
        parsePower();

      if (
        op === "/" ||
        op === "%"
      ) {
        if (
          right === 0
        ) {
          throw new Error(
            "0 ga bo‘lish mumkin emas"
          );
        }
      }

      if (
        op === "*"
      ) {
        value *=
          right;
      } else if (
        op === "/"
      ) {
        value /=
          right;
      } else {
        value %=
          right;
      }

      ensureFinite(
        value
      );
    }

    return value;
  }

  function parsePower() {
    let value =
      parseUnary();

    if (
      pos <
        tokens.length &&
      tokens[pos].type ===
        "^"
    ) {
      pos++;

      const right =
        parsePower();

      value =
        Math.pow(
          value,
          right
        );

      ensureFinite(
        value
      );
    }

    return value;
  }

  function parseUnary() {
    if (
      pos <
        tokens.length &&
      tokens[pos].type ===
        "+"
    ) {
      pos++;

      return parseUnary();
    }

    if (
      pos <
        tokens.length &&
      tokens[pos].type ===
        "-"
    ) {
      pos++;

      return ensureFinite(
        -parseUnary()
      );
    }

    return parsePostfix();
  }

  function parsePostfix() {
    let value =
      parsePrimary();

    while (
      pos <
      tokens.length
    ) {
      if (
        tokens[pos].type ===
        "!"
      ) {
        pos++;

        value =
          factorial(
            value
          );

        continue;
      }

      if (
        tokens[pos].type ===
        "%"
      ) {
        const next =
          tokens[pos + 1];

        if (
          !next ||
          next.type ===
            ")" ||
          next.type ===
            "+" ||
          next.type ===
            "-"
        ) {
          pos++;

          value /=
            100;

          continue;
        }
      }

      break;
    }

    return ensureFinite(
      value
    );
  }

  function parsePrimary() {
    if (
      pos >=
      tokens.length
    ) {
      throw new Error(
        "Ifoda tugallanmagan"
      );
    }

    const token =
      tokens[pos];

    if (
      token.type ===
      "number"
    ) {
      pos++;

      return token.value;
    }

    if (
      token.type ===
      "identifier"
    ) {
      pos++;

      const name =
        token.value;

      if (
        pos <
          tokens.length &&
        tokens[pos].type ===
          "("
      ) {
        pos++;

        const args = [];

        if (
          pos <
            tokens.length &&
          tokens[pos].type !==
            ")"
        ) {
          args.push(
            parseExpression()
          );

          while (
            pos <
              tokens.length &&
            tokens[pos].type ===
              ","
          ) {
            pos++;

            args.push(
              parseExpression()
            );
          }
        }

        if (
          pos >=
            tokens.length ||
          tokens[pos].type !==
            ")"
        ) {
          throw new Error(
            "Funksiya qavsi yopilmagan"
          );
        }

        pos++;

        if (
          !Object.prototype.hasOwnProperty.call(
            functions,
            name
          )
        ) {
          throw new Error(
            `Noma’lum funksiya: ${name}`
          );
        }

        const fn =
          functions[name];

        let result;

        if (
          name ===
          "pow"
        ) {
          if (
            args.length !== 2
          ) {
            throw new Error(
              "pow(a,b) ikkita qiymat oladi"
            );
          }

          result =
            fn(
              args[0],
              args[1]
            );
        } else if (
          name === "min" ||
          name === "max"
        ) {
          if (
            !args.length
          ) {
            throw new Error(
              `${name}() kamida bitta qiymat oladi`
            );
          }

          result =
            fn(...args);
        } else {
          if (
            args.length !== 1
          ) {
            throw new Error(
              `${name}() bitta qiymat oladi`
            );
          }

          result =
            fn(args[0]);
        }

        return ensureFinite(
          result
        );
      }

      if (
        Object.prototype.hasOwnProperty.call(
          constants,
          name
        )
      ) {
        return constants[name];
      }

      throw new Error(
        `Noma’lum matematik nom: ${name}`
      );
    }

    if (
      token.type ===
      "("
    ) {
      pos++;

      const value =
        parseExpression();

      if (
        pos >=
          tokens.length ||
        tokens[pos].type !==
          ")"
      ) {
        throw new Error(
          "Qavslar noto‘g‘ri"
        );
      }

      pos++;

      return value;
    }

    throw new Error(
      "Ifoda noto‘g‘ri"
    );
  }

  const result =
    parseExpression();

  if (
    pos !==
    tokens.length
  ) {
    throw new Error(
      "Ifodaning bir qismi tushunilmadi"
    );
  }

  return ensureFinite(
    result
  );
}

function solveQuadratic(
  text
) {
  let q =
    normalizeMathQuestion(
      text
    )
      .replace(
        /x²/g,
        "x^2"
      )
      .replace(
        /\s+/g,
        ""
      );

  if (
    !q.includes("=") ||
    !q.includes("x")
  ) {
    return null;
  }

  const parts =
    q.split("=");

  if (
    parts.length !== 2
  ) {
    return null;
  }

  function parsePolynomial(
    poly
  ) {
    let clean =
      poly
        .replace(
          /\(/g,
          ""
        )
        .replace(
          /\)/g,
          ""
        );

    clean =
      clean.replace(
        /-/g,
        "+-"
      );

    if (
      clean.startsWith("+")
    ) {
      clean =
        clean.slice(1);
    }

    const terms =
      clean
        .split("+")
        .filter(Boolean);

    let a = 0;
    let b = 0;
    let c = 0;

    for (
      let term
      of terms
    ) {
      term =
        term.replace(
          /\*/g,
          ""
        );

      let match =
        term.match(
          /^([+-]?\d*\.?\d*)x\^2$/
        );

      if (match) {
        let coef =
          match[1];

        if (
          coef === "" ||
          coef === "+"
        ) {
          coef = 1;
        } else if (
          coef === "-"
        ) {
          coef = -1;
        } else {
          coef =
            Number(coef);
        }

        a += coef;
        continue;
      }

      match =
        term.match(
          /^([+-]?\d*\.?\d*)x$/
        );

      if (match) {
        let coef =
          match[1];

        if (
          coef === "" ||
          coef === "+"
        ) {
          coef = 1;
        } else if (
          coef === "-"
        ) {
          coef = -1;
        } else {
          coef =
            Number(coef);
        }

        b += coef;
        continue;
      }

      if (
        /^[+-]?\d*\.?\d+$/.test(
          term
        )
      ) {
        c +=
          Number(term);

        continue;
      }

      return null;
    }

    return {
      a,
      b,
      c
    };
  }

  const left =
    parsePolynomial(
      parts[0]
    );

  const right =
    parsePolynomial(
      parts[1]
    );

  if (
    !left ||
    !right
  ) {
    return null;
  }

  const a =
    left.a -
    right.a;

  const b =
    left.b -
    right.b;

  const c =
    left.c -
    right.c;

  if (
    Math.abs(a) <
      1e-12 &&
    Math.abs(b) <
      1e-12
  ) {
    return null;
  }

  if (
    Math.abs(a) <
    1e-12
  ) {
    const x =
      -c / b;

    return {
      answer:
        `Tenglama yechimi: x = ${formatNumber(x)}`
    };
  }

  const D =
    b * b -
    4 *
      a *
      c;

  if (
    D < 0
  ) {
    const real =
      -b /
      (2 * a);

    const imaginary =
      Math.sqrt(
        -D
      ) /
      Math.abs(
        2 * a
      );

    return {
      answer:
        `Diskriminant D = ${formatNumber(D)}.\n` +
        `Haqiqiy ildiz yo‘q.\n` +
        `Kompleks ildizlar:\n` +
        `x₁ = ${formatNumber(real)} + ${formatNumber(imaginary)}i\n` +
        `x₂ = ${formatNumber(real)} - ${formatNumber(imaginary)}i`
    };
  }

  if (
    Math.abs(D) <
    1e-12
  ) {
    const x =
      -b /
      (2 * a);

    return {
      answer:
        `Diskriminant D = 0.\n` +
        `Yagona ildiz: x = ${formatNumber(x)}`
    };
  }

  const sqrtD =
    Math.sqrt(D);

  const x1 =
    (
      -b +
      sqrtD
    ) /
    (2 * a);

  const x2 =
    (
      -b -
      sqrtD
    ) /
    (2 * a);

  return {
    answer:
      `Diskriminant D = ${formatNumber(D)}.\n` +
      `x₁ = ${formatNumber(x1)}\n` +
      `x₂ = ${formatNumber(x2)}`
  };
}

function derivativePolynomial(
  text
) {
  const q =
    normalizeMathQuestion(
      text
    );

  if (
    !q.includes("d/dx") &&
    !q.includes("hosila")
  ) {
    return null;
  }

  let expr =
    q
      .replace(
        /^.*d\/dx\s*\(?/i,
        ""
      )
      .replace(
        /\)?\s*$/g,
        ""
      )
      .replace(
        /^.*hosila\s*[:=]?\s*/i,
        ""
      )
      .trim();

  expr =
    expr
      .replace(
        /x²/g,
        "x^2"
      )
      .replace(
        /\s+/g,
        ""
      );

  const terms =
    expr
      .replace(
        /-/g,
        "+-"
      )
      .split("+")
      .filter(Boolean);

  if (!terms.length) {
    return null;
  }

  const resultTerms =
    [];

  for (
    const originalTerm
    of terms
  ) {
    const term =
      originalTerm
        .replace(
          /\*/g,
          ""
        );

    if (
      term === "x"
    ) {
      resultTerms.push(
        "1"
      );

      continue;
    }

    let match =
      term.match(
        /^([+-]?\d*\.?\d*)x\^(\d+(?:\.\d+)?)$/
      );

    if (match) {
      let coef =
        match[1];

      if (
        coef === "" ||
        coef === "+"
      ) {
        coef = 1;
      } else if (
        coef === "-"
      ) {
        coef = -1;
      } else {
        coef =
          Number(coef);
      }

      const power =
        Number(match[2]);

      const newCoef =
        coef * power;

      const newPower =
        power - 1;

      if (
        Math.abs(
          newPower
        ) < 1e-12
      ) {
        resultTerms.push(
          formatNumber(
            newCoef
          )
        );
      } else if (
        Math.abs(
          newPower - 1
        ) < 1e-12
      ) {
        resultTerms.push(
          `${formatNumber(newCoef)}x`
        );
      } else {
        resultTerms.push(
          `${formatNumber(newCoef)}x^${formatNumber(newPower)}`
        );
      }

      continue;
    }

    match =
      term.match(
        /^([+-]?\d*\.?\d*)x$/
      );

    if (match) {
      let coef =
        match[1];

      if (
        coef === "" ||
        coef === "+"
      ) {
        coef = 1;
      } else if (
        coef === "-"
      ) {
        coef = -1;
      } else {
        coef =
          Number(coef);
      }

      resultTerms.push(
        formatNumber(coef)
      );

      continue;
    }

    if (
      /^[+-]?\d*\.?\d+$/.test(
        term
      )
    ) {
      continue;
    }

    return null;
  }

  if (
    !resultTerms.length
  ) {
    return {
      answer:
        "Hosila: 0"
    };
  }

  const resultText =
    resultTerms
      .join(" + ")
      .replace(
        /\+\s+-/g,
        "- "
      );

  return {
    answer:
      `Hosila: ${resultText}`
  };
}

function definitePolynomialIntegral(
  text
) {
  const q =
    normalizeMathQuestion(
      text
    );

  if (
    !q.includes(
      "integral"
    ) &&
    !q.includes("∫")
  ) {
    return null;
  }

  let expression = "";

  let lower = null;

  let upper = null;

  let match =
    q.match(
      /(?:integral|∫)\s*(-?\d+(?:\.\d+)?)\s*(?:dan|to|-)\s*(-?\d+(?:\.\d+)?)\s*(?:gacha)?\s+(.+)/
    );

  if (match) {
    lower =
      Number(
        match[1]
      );

    upper =
      Number(
        match[2]
      );

    expression =
      match[3];
  }

  if (
    lower === null ||
    upper === null
  ) {
    match =
      q.match(
        /(.+?)\s+(?:dan|from)\s+(-?\d+(?:\.\d+)?)\s+(?:gacha|to)\s+(-?\d+(?:\.\d+)?)/
      );

    if (match) {
      expression =
        match[1];

      lower =
        Number(
          match[2]
        );

      upper =
        Number(
          match[3]
        );
    }
  }

  if (
    lower === null ||
    upper === null ||
    !Number.isFinite(
      lower
    ) ||
    !Number.isFinite(
      upper
    ) ||
    !expression
  ) {
    return null;
  }

  const terms =
    expression
      .replace(
        /x²/g,
        "x^2"
      )
      .replace(
        /\s+/g,
        ""
      )
      .replace(
        /-/g,
        "+-"
      )
      .split("+")
      .filter(Boolean);

  function antiDerivativeAt(
    x
  ) {
    let total = 0;

    for (
      const originalTerm
      of terms
    ) {
      const term =
        originalTerm
          .replace(
            /\*/g,
            ""
          );

      let match =
        term.match(
          /^([+-]?\d*\.?\d*)x\^(\d+(?:\.\d+)?)$/
        );

      if (match) {
        let coef =
          match[1];

        if (
          coef === "" ||
          coef === "+"
        ) {
          coef = 1;
        } else if (
          coef === "-"
        ) {
          coef = -1;
        } else {
          coef =
            Number(coef);
        }

        const power =
          Number(
            match[2]
          );

        total +=
          coef *
          Math.pow(
            x,
            power + 1
          ) /
          (power + 1);

        continue;
      }

      match =
        term.match(
          /^([+-]?\d*\.?\d*)x$/
        );

      if (match) {
        let coef =
          match[1];

        if (
          coef === "" ||
          coef === "+"
        ) {
          coef = 1;
        } else if (
          coef === "-"
        ) {
          coef = -1;
        } else {
          coef =
            Number(coef);
        }

        total +=
          coef *
          x *
          x /
          2;

        continue;
      }

      if (
        /^[+-]?\d*\.?\d+$/.test(
          term
        )
      ) {
        total +=
          Number(term) *
          x;

        continue;
      }

      throw new Error(
        "Bu integral turi hozircha qo‘llanmagan."
      );
    }

    return total;
  }

  try {
    const result =
      antiDerivativeAt(
        upper
      ) -
      antiDerivativeAt(
        lower
      );

    return {
      answer:
        `Aniq integral natijasi: ${formatNumber(result)}`
    };
  } catch {
    return null;
  }
}

function prepareMathExpression(
  expression
) {
  let expr =
    String(
      expression || ""
    )
      .trim()
      .replace(
        /π/g,
        "pi"
      )
      .replace(
        /√\s*([0-9.]+)/g,
        "sqrt($1)"
      );

  expr =
    expr.replace(
      /(\d+(?:\.\d+)?)%(?=\s*(?:$|[+\-*/^)]))/g,
      "($1/100)"
    );

  expr =
    expr.replace(
      /(\d+(?:\.\d+)?)%(?=\s*\))/g,
      "($1/100)"
    );

  return expr;
}

function tryCalculate(
  text
) {
  const original =
    String(text || "")
      .trim();

  if (!original) {
    return null;
  }

  const percentage =
    calculatePercentage(
      original
    );

  if (percentage) {
    return {
      expression:
        original,
      result:
        percentage.result,
      answer:
        `Javob: ${percentage.answer}`
    };
  }

  const quadratic =
    solveQuadratic(
      original
    );

  if (quadratic) {
    return {
      expression:
        original,
      result:
        null,
      answer:
        quadratic.answer
    };
  }

  const derivative =
    derivativePolynomial(
      original
    );

  if (derivative) {
    return {
      expression:
        original,
      result:
        null,
      answer:
        derivative.answer
    };
  }

  const integral =
    definitePolynomialIntegral(
      original
    );

  if (integral) {
    return {
      expression:
        original,
      result:
        null,
      answer:
        integral.answer
    };
  }

  let expression =
    normalizeMathQuestion(
      original
    )
      .replace(
        /^(hisobla|hisoblab ber|hisob-kitob|calculate)\s*/i,
        ""
      )
      .replace(
        /^(necha|qancha|natijasi)\s+boladi\s*/i,
        ""
      )
      .replace(
        /\?+$/g,
        ""
      )
      .trim();

  expression =
    prepareMathExpression(
      expression
    );

  const containsNumber =
    /[0-9]/.test(
      expression
    );

  const containsMathOperator =
    /[+\-*/%^()]/.test(
      expression
    );

  const containsMathFunction =
    /\b(sqrt|sin|cos|tan|asin|acos|atan|log|ln|exp|abs|floor|ceil|round|fact|pow|min|max)\b/i
      .test(
        expression
      ) ||
    /\bpi\b|\be\b/i.test(
      expression
    );

  if (
    !containsNumber ||
    (
      !containsMathOperator &&
      !containsMathFunction
    )
  ) {
    return null;
  }

  if (
    !/^[0-9a-zA-Z_+\-*/%^().,\s√]+$/u.test(
      expression
    )
  ) {
    return null;
  }

  try {
    const result =
      evaluateAdvancedExpression(
        expression
      );

    return {
      expression,
      result,
      answer:
        `Javob: ${formatNumber(result)}`
    };
  } catch (e) {
    console.error(
      "CALCULATOR ERROR:",
      e.message
    );

    return null;
  }
}

// ============================================================
// TRANSLATOR
// GOOGLE PUBLIC ENDPOINT + LIBRETRANSLATE FALLBACK
// API KEY TALAB QILMAYDI
// ============================================================

const TRANSLATION_LANGUAGES = {
  uz: [
    "uzbek",
    "uzbekcha",
    "uzbekga",
    "uzbekchaga",
    "ozbek",
    "ozbekcha",
    "ozbekga",
    "ozbekchaga",
    "o'zbek",
    "o'zbekcha",
    "o'zbekga",
    "o'zbekchaga",
    "o‘'zbek",
    "узбек",
    "узбекский",
    "узбекча",
    "uz"
  ],

  ru: [
    "rus",
    "ruscha",
    "rusga",
    "ruschaga",
    "russ",
    "russian",
    "русский",
    "русскому",
    "русча",
    "руска",
    "руский",
    "ru"
  ],

  en: [
    "ingliz",
    "inglizcha",
    "inglizga",
    "inglizchaga",
    "inglis",
    "inglischa",
    "inglich",
    "inglichcha",
    "english",
    "английский",
    "английскому",
    "англич",
    "en"
  ],

  kk: [
    "qozoq",
    "qozoqcha",
    "qozoqqa",
    "qozoqchaga",
    "qazaq",
    "kazakh",
    "қазақ",
    "қазақша",
    "казахский",
    "kk"
  ],

  tr: [
    "turk",
    "turkcha",
    "turkka",
    "turkchaga",
    "turkish",
    "türkçe",
    "турецкий",
    "tr"
  ],

  tg: [
    "tojik",
    "tojikcha",
    "tojikka",
    "tojikchaga",
    "tajik",
    "тоҷик",
    "таджикский",
    "tg"
  ],

  ar: [
    "arab",
    "arabcha",
    "arabga",
    "arabchaga",
    "arabic",
    "арабский",
    "العربية",
    "ar"
  ],

  de: [
    "nemis",
    "nemischa",
    "nemisga",
    "nemischaga",
    "german",
    "deutsch",
    "немецкий",
    "de"
  ],

  fr: [
    "fransuz",
    "fransuzcha",
    "fransuzga",
    "fransuzchaga",
    "french",
    "français",
    "французский",
    "fr"
  ],

  es: [
    "ispan",
    "ispancha",
    "ispanga",
    "ispanchaga",
    "spanish",
    "español",
    "испанский",
    "es"
  ],

  it: [
    "italyan",
    "italyancha",
    "italyanga",
    "italyanchaga",
    "italian",
    "italiano",
    "итальянский",
    "it"
  ],

  zh: [
    "xitoy",
    "xitoycha",
    "xitoyga",
    "xitoychaga",
    "chinese",
    "中文",
    "китайский",
    "zh"
  ],

  ko: [
    "koreys",
    "koreyscha",
    "koreysga",
    "koreyschaga",
    "korean",
    "한국어",
    "корейский",
    "ko"
  ],

  ja: [
    "yapon",
    "yaponcha",
    "yaponga",
    "yaponchaga",
    "japanese",
    "日本語",
    "японский",
    "ja"
  ],

  hi: [
    "hind",
    "hindcha",
    "hindga",
    "hindchaga",
    "hindi",
    "हिन्दी",
    "хиндӣ",
    "hi"
  ],

  pt: [
    "portugal",
    "portugalcha",
    "portugalga",
    "portugalchaga",
    "portuguese",
    "português",
    "португальский",
    "pt"
  ]
};

function normalizeTranslationText(
  text
) {
  return String(text || "")
    .toLowerCase()
    .replace(
      /[ʻ’‘`´]/g,
      "'"
    )
    .replace(
      /[?!.,;:()[\]{}]/g,
      " "
    )
    .replace(
      /\s+/g,
      " "
    )
    .trim();
}

function normalizeTranslationAlias(
  text
) {
  return normalizeTranslationText(
    text
  )
    .replace(
      /\btiliga\b/g,
      ""
    )
    .replace(
      /\btilga\b/g,
      ""
    )
    .replace(
      /\btil\b/g,
      ""
    )
    .trim();
}

function translationLanguageCode(
  input
) {
  const value =
    normalizeTranslationAlias(
      input
    );

  if (!value) {
    return null;
  }

  let bestCode = null;
  let bestScore = 0;

  for (
    const [code, aliases]
    of Object.entries(
      TRANSLATION_LANGUAGES
    )
  ) {
    for (
      const alias
      of aliases
    ) {
      const a =
        normalizeTranslationAlias(
          alias
        );

      if (!a) {
        continue;
      }

      if (
        value === a
      ) {
        return code;
      }

      if (
        value.includes(a)
      ) {
        if (
          bestScore < 100
        ) {
          bestCode = code;
          bestScore = 100;
        }

        continue;
      }

      const valueWords =
        value.split(
          /\s+/
        );

      const aliasWords =
        a.split(
          /\s+/
        );

      if (
        valueWords.length === 1 &&
        aliasWords.length === 1
      ) {
        const distance =
          levenshtein(
            valueWords[0],
            aliasWords[0]
          );

        if (
          distance <= 1 &&
          bestScore < 95
        ) {
          bestCode =
            code;

          bestScore =
            95;
        } else if (
          distance <= 2 &&
          bestScore < 85
        ) {
          bestCode =
            code;

          bestScore =
            85;
        } else if (
          distance <= 3 &&
          a.length >= 6 &&
          bestScore < 70
        ) {
          bestCode =
            code;

          bestScore =
            70;
        }
      }
    }
  }

  return bestCode;
}

function extractTranslationTarget(
  text
) {
  const original =
    String(text || "")
      .trim();

  if (!original) {
    return null;
  }

  const normalized =
    normalizeTranslationText(
      original
    );

  let bestCode = null;
  let bestLength = 0;

  for (
    const [code, aliases]
    of Object.entries(
      TRANSLATION_LANGUAGES
    )
  ) {
    for (
      const alias
      of aliases
    ) {
      const a =
        normalizeTranslationAlias(
          alias
        );

      if (!a) {
        continue;
      }

      const escaped =
        a.replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&"
        );

      const pattern =
        new RegExp(
          `(?:^|\\s|:|-)(?:${escaped})(?=\\s|:|-|$)`,
          "iu"
        );

      if (
        pattern.test(
          normalized
        )
      ) {
        if (
          a.length >
          bestLength
        ) {
          bestCode =
            code;

          bestLength =
            a.length;
        }
      }
    }
  }

  if (bestCode) {
    return bestCode;
  }

  const words =
    normalized
      .split(/\s+/)
      .filter(Boolean);

  for (
    const word
    of words
  ) {
    const code =
      translationLanguageCode(
        word
      );

    if (code) {
      return code;
    }
  }

  return null;
}

function removeTranslationCommand(
  text,
  targetCode
) {
  let value =
    String(text || "")
      .trim();

  const aliases =
    [
      ...(TRANSLATION_LANGUAGES[
        targetCode
      ] || [])
    ].sort(
      (a, b) =>
        b.length - a.length
    );

  for (
    const alias
    of aliases
  ) {
    const escaped =
      normalizeTranslationAlias(
        alias
      ).replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&"
      );

    value =
      value.replace(
        new RegExp(
          `(?:^|\\s|:|-)(?:${escaped})(?=\\s|:|-|$)`,
          "giu"
        ),
        " "
      );
  }

  value =
    value
      .replace(
        /(?:^|\s)(?:shu\s+gapni|shu\s+matnni|shu\s+matn|shu\s+gap|matnni|gapni)(?=\s|:|$)/iu,
        " "
      )
      .replace(
        /(?:^|\s)(?:tarjima\s+qil|tarjima\s+qilib\s+ber|tarjima|tarjma|o'gir|ogir|o'girish|ogirish|perevod\s+qil|perevod|perevot\s+qil|perevot|perewot|переведи|перевод|translate)(?=\s|:|$)/iu,
        " "
      )
      .replace(
        /^(?:to|into|на|на\s+язык|к|для)\s+/iu,
        ""
      );

  const colon =
    value.indexOf(":");

  if (colon >= 0) {
    const left =
      normalizeTranslationText(
        value.slice(
          0,
          colon
        )
      );

    if (
      /(?:tarjima|tarjma|o'g|ogir|perevod|perevot|translate|рус|инглиз|ruscha|ruschaga|inglizcha|inglizchaga|uzbekcha|ozbekcha)/iu
        .test(left)
    ) {
      value =
        value.slice(
          colon + 1
        );
    }
  }

  value =
    value
      .replace(
        /^(?:shu\s+gapni|shu\s+matnni|shu\s+matn|shu\s+gap|matnni|gapni)\s*/iu,
        ""
      )
      .replace(
        /^(?:tarjima\s+qil|tarjima\s+qilib\s+ber|tarjima|tarjma|o'gir|ogir|o'girish|ogirish|perevod\s+qil|perevod|perevot\s+qil|perevot|perewot|переведи|перевод|translate)\s*:?\s*/iu,
        ""
      );

  value =
    value
      .replace(
        /\s+(?:ni|nı)\s*$/iu,
        ""
      )
      .replace(
        /^[\s:,\-]+/,
        ""
      )
      .replace(
        /[\s:,\-]+$/,
        ""
      )
      .replace(
        /\s+/g,
        " "
      )
      .trim();

  return value;
}

function findTranslationIntent(
  text
) {
  const original =
    String(text || "")
      .trim();

  if (!original) {
    return null;
  }

  const q =
    normalizeTranslationText(
      original
    );

  const hasCommand =
    /(?:tarjima|tarjma|o'gir|ogir|perevod|perevot|perewot|translate|перевод|переведи)/iu
      .test(q);

  const targetCode =
    extractTranslationTarget(
      original
    );

  const hasTarget =
    Boolean(
      targetCode
    );

  if (
    !hasCommand &&
    !hasTarget
  ) {
    return null;
  }

  if (!targetCode) {
    return {
      targetCode:
        null,
      sourceText:
        "",
      error:
        "Tarjima tilini aniqlab bo‘lmadi."
    };
  }

  const sourceText =
    removeTranslationCommand(
      original,
      targetCode
    );

  if (!sourceText) {
    return {
      targetCode,
      sourceText:
        "",
      error:
        "Tarjima qilinadigan matn topilmadi."
    };
  }

  return {
    targetCode,
    sourceText
  };
}

// ------------------------------------------------------------
// GOOGLE PUBLIC TRANSLATE
// API KEY SHART EMAS
// ------------------------------------------------------------

async function translateWithGooglePublic(
  sourceText,
  targetCode
) {
  const url =
    "https://translate.googleapis.com/translate_a/single" +
    "?client=gtx" +
    "&sl=auto" +
    `&tl=${encodeURIComponent(
      targetCode
    )}` +
    "&dt=t" +
    `&q=${encodeURIComponent(
      sourceText
    )}`;

  console.log(
    "Google public translate:",
    targetCode
  );

  const response =
    await fetch(
      url,
      {
        method:
          "GET",
        headers: {
          "Accept":
            "application/json",
          "User-Agent":
            "QamirAI/1.0"
        },
        signal:
          AbortSignal.timeout(
            15000
          )
      }
    );

  if (
    !response.ok
  ) {
    const body =
      await response
        .text()
        .catch(
          () => ""
        );

    throw new Error(
      `Google Translate HTTP ${response.status}: ${body.slice(0, 300)}`
    );
  }

  const data =
    await response.json()
      .catch(
        () => null
      );

  if (!data) {
    throw new Error(
      "Google Translate javobi JSON emas."
    );
  }

  const pieces = [];

  if (
    Array.isArray(
      data[0]
    )
  ) {
    for (
      const item
      of data[0]
    ) {
      if (
        Array.isArray(item) &&
        typeof item[0] ===
          "string"
      ) {
        pieces.push(
          item[0]
        );
      }
    }
  }

  const translated =
    pieces
      .join("")
      .trim();

  if (!translated) {
    throw new Error(
      "Google Translate tarjima qaytarmadi."
    );
  }

  return {
    text:
      translated,
    detectedSource:
      typeof data[2] ===
      "string"
        ? data[2]
        : ""
  };
}

// ------------------------------------------------------------
// LIBRETRANSLATE FALLBACK
// ------------------------------------------------------------

const LIBRETRANSLATE_ENDPOINTS = [
  "https://translate.cutie.dating/translate",
  "https://translate.fedilab.app/translate"
];

async function translateWithLibreTranslate(
  sourceText,
  targetCode
) {
  let lastError =
    "LibreTranslate serverlari javob bermadi.";

  for (
    const endpoint
    of LIBRETRANSLATE_ENDPOINTS
  ) {
    try {
      console.log(
        "LibreTranslate so‘rovi:",
        endpoint,
        "target=",
        targetCode
      );

      const response =
        await fetch(
          endpoint,
          {
            method:
              "POST",
            headers: {
              "Content-Type":
                "application/json",
              "Accept":
                "application/json",
              "User-Agent":
                "QamirAI/1.0"
            },
            body:
              JSON.stringify({
                q:
                  sourceText,
                source:
                  "auto",
                target:
                  targetCode,
                format:
                  "text"
              }),
            signal:
              AbortSignal.timeout(
                15000
              )
          }
        );

      const data =
        await response
          .json()
          .catch(
            () => ({})
          );

      if (
        !response.ok
      ) {
        lastError =
          data?.error ||
          `LibreTranslate HTTP ${response.status}`;

        console.error(
          "LibreTranslate xatosi:",
          endpoint,
          lastError
        );

        continue;
      }

      const translated =
        data?.translatedText;

      if (
        typeof translated ===
          "string" &&
        translated.trim()
      ) {
        return {
          text:
            translated.trim(),
          detectedSource:
            data?.detectedLanguage
              ?.language ||
            data?.detectedSourceLanguage ||
            ""
        };
      }

      lastError =
        "LibreTranslate javobida translatedText topilmadi.";
    } catch (e) {
      lastError =
        e?.message ||
        "LibreTranslate ulanish xatosi";

      console.error(
        "LibreTranslate endpoint xatosi:",
        endpoint,
        lastError
      );
    }
  }

  throw new Error(
    lastError
  );
}

// ------------------------------------------------------------
// ASOSIY TRANSLATOR
// GOOGLE -> LIBRETRANSLATE
// ------------------------------------------------------------

async function tryTranslate(
  text
) {
  const intent =
    findTranslationIntent(
      text
    );

  if (!intent) {
    return null;
  }

  if (
    intent.error
  ) {
    throw new Error(
      intent.error
    );
  }

  let googleError =
    "";

  try {
    const result =
      await translateWithGooglePublic(
        intent.sourceText,
        intent.targetCode
      );

    return {
      sourceText:
        intent.sourceText,
      targetCode:
        intent.targetCode,
      translated:
        result.text,
      detectedSource:
        result.detectedSource
    };
  } catch (e) {
    googleError =
      e?.message ||
      "Google public translate xatosi";

    console.error(
      "GOOGLE PUBLIC TRANSLATE ERROR:",
      googleError
    );
  }

  try {
    const result =
      await translateWithLibreTranslate(
        intent.sourceText,
        intent.targetCode
      );

    return {
      sourceText:
        intent.sourceText,
      targetCode:
        intent.targetCode,
      translated:
        result.text,
      detectedSource:
        result.detectedSource
    };
  } catch (e) {
    const libreError =
      e?.message ||
      "LibreTranslate xatosi";

    console.error(
      "LIBRETRANSLATE ERROR:",
      libreError
    );

    throw new Error(
      `Tarjima serverlari ishlamadi. Google: ${googleError || "noma'lum"}. LibreTranslate: ${libreError}`
    );
  }
}

// ============================================================
// GEMINI
// ============================================================

async function getSettings() {
  const rows =
    await db(
      `SELECT * FROM settings WHERE id = 1`
    );

  return rows[0] || {};
}

async function askGemini(
  userText,
  history,
  knowledge
) {
  const key =
    process.env.GEMINI_API_KEY;

  if (!key) {
    return null;
  }

  const settings =
    await getSettings();

  const model =
    process.env.GEMINI_MODEL ||
    settings.model ||
    "gemini-2.5-flash";

  const context =
    knowledge
      .map(
        (x, i) =>
          `[QAMIR BILIMI ${i + 1}]
Savol: ${x.question || x.title}
Javob: ${x.answer}`
      )
      .join("\n\n");

  const systemPrompt = `
Siz Qamir AI nomli shaxsiy sun'iy intellekt yordamchisisiz.

ASOSIY TAMOYIL:
Qamir AI ning asosiy manbasi Admin bergan bilimlardir.
Gemini faqat yordamchi vosita.

Agar mos bilim aniq topilsa,
shu bilimga tayaning.

Agar mos bilim topilmasa,
savolga umumiy foydali javob bering.

Boshqa mavzudagi bilimni foydalanuvchi
savoliga mos deb ko‘rsatmang.

Faktni o‘ylab topmang.

AGENT ROLI:
${settings.role || ""}

ASOSIY KO‘RSATMA:
${settings.instruction || ""}

MAJBURIY QOIDALAR:
${settings.must_rules || ""}

TAQIQLAR:
${settings.never_rules || ""}

MIJOZ BILAN MUOMALA:
${settings.customer_rules || ""}

JAVOB USLUBI:
Til: ${settings.language || "O‘zbek"}
Ohang: ${settings.tone || "Samimiy"}
Emoji: ${settings.emoji || "some"}
Uzunlik: ${settings.answer_length || "O‘rtacha"}

MUHIM:
Savolga to‘g‘ridan-to‘g‘ri va tabiiy javob bering.
Bilim matnini to‘liq ko‘chirmang.
Agar foydalanuvchi hisob-kitob so‘rasa,
aniq natija bering.

QAMIR BILIMLARI:
${context || "(Mos bilim topilmadi.)"}
`;

  const contents =
    (history || [])
      .slice(-18)
      .map(
        m => ({
          role:
            m.sender ===
            "assistant"
              ? "model"
              : "user",
          parts: [
            {
              text:
                String(
                  m.text
                )
            }
          ]
        })
      );

  contents.push({
    role:
      "user",
    parts: [
      {
        text:
          String(
            userText
          )
      }
    ]
  });

  const response =
    await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`,
      {
        method:
          "POST",
        headers: {
          "Content-Type":
            "application/json"
        },
        body:
          JSON.stringify({
            systemInstruction: {
              parts: [
                {
                  text:
                    systemPrompt
                }
              ]
            },
            contents,
            generationConfig: {
              temperature:
                Math.max(
                  0,
                  Math.min(
                    2,
                    Number(
                      settings.temperature ??
                      0.7
                    )
                  )
                ),
              maxOutputTokens:
                Math.max(
                  64,
                  Math.min(
                    8192,
                    Number(
                      settings.max_tokens ??
                      1024
                    )
                  )
                )
            }
          })
      }
    );

  const data =
    await response
      .json()
      .catch(
        () => ({})
      );

  if (
    !response.ok
  ) {
    throw new Error(
      data?.error?.message ||
      `Gemini HTTP ${response.status}`
    );
  }

  return (
    data
      ?.candidates?.[0]
      ?.content?.parts ||
    []
  )
    .map(
      p => p.text || ""
    )
    .join("")
    .trim() ||
    null;
}

// ============================================================
// HEALTH / AUTH
// ============================================================

app.get(
  "/api/health",
  async (
    req,
    res
  ) => {
    try {
      await db(
        "SELECT 1"
      );

      res.json({
        ok:
          true,

        database:
          "connected",

        gemini:
          Boolean(
            process.env
              .GEMINI_API_KEY
          ),

        translator:
          true,

        model:
          process.env
            .GEMINI_MODEL ||
          "gemini-2.5-flash"
      });
    } catch (e) {
      res.status(500).json({
        ok:
          false,

        database:
          "error",

        error:
          e.message
      });
    }
  }
);

async function register(
  req,
  res
) {
  try {
    const {
      username,
      email = "",
      password
    } =
      req.body || {};

    const un =
      String(
        username || ""
      ).trim();

    if (
      un.length < 3 ||
      String(
        password || ""
      ).length < 6
    ) {
      return res
        .status(400)
        .json({
          error:
            "Login kamida 3, parol kamida 6 belgidan iborat bo'lsin"
        });
    }

    const rows =
      await db(
        `INSERT INTO users
         (username, email, password_hash)
         VALUES ($1, $2, $3)
         RETURNING id, username, email, birth_date,
                   city, avatar, is_admin,
                   created_at, last_seen`,
        [
          un,
          String(
            email
          ).trim(),
          hashPassword(
            password
          )
        ]
      );

    res
      .status(201)
      .json({
        success:
          true,

        user:
          safeUser(
            rows[0]
          ),

        token:
          String(
            rows[0].id
          )
      });
  } catch (e) {
    if (
      e.code ===
      "23505"
    ) {
      return res
        .status(409)
        .json({
          error:
            "Bu login allaqachon mavjud"
        });
    }

    console.error(
      "REGISTER ERROR:",
      e
    );

    res
      .status(500)
      .json({
        error:
          "Ro'yxatdan o'tishda server xatosi"
      });
  }
}

async function login(
  req,
  res
) {
  try {
    const {
      username,
      password
    } =
      req.body || {};

    const rows =
      await db(
        `SELECT id, username, email, birth_date,
                city, avatar, is_admin,
                created_at, last_seen
         FROM users
         WHERE LOWER(username) = LOWER($1)
           AND password_hash = $2
         LIMIT 1`,
        [
          String(
            username || ""
          ).trim(),
          hashPassword(
            password || ""
          )
        ]
      );

    if (
      !rows.length
    ) {
      return res
        .status(401)
        .json({
          error:
            "Login yoki parol noto'g'ri"
        });
    }

    await db(
      `UPDATE users
       SET last_seen = NOW()
       WHERE id = $1`,
      [
        rows[0].id
      ]
    );

    res.json({
      success:
        true,

      user:
        safeUser(
          rows[0]
        ),

      token:
        String(
          rows[0].id
        )
    });
  } catch (e) {
    console.error(
      "LOGIN ERROR:",
      e
    );

    res
      .status(500)
      .json({
        error:
          "Kirishda server xatosi"
      });
  }
}

app.post(
  "/api/auth/register",
  register
);

app.post(
  "/api/register",
  register
);

app.post(
  "/api/auth/login",
  login
);

app.post(
  "/api/login",
  login
);

app.get(
  "/api/me",
  requireUser,
  async (
    req,
    res
  ) => {
    res.json({
      success:
        true,
      user:
        safeUser(
          req.user
        )
    });
  }
);

// ============================================================
// KNOWLEDGE CRUD
// ============================================================

app.get(
  "/api/knowledge",
  requireUser,
  async (
    req,
    res
  ) => {
    try {
      const rows =
        await db(`
          SELECT id, title, question, answer,
                 raw_text AS text,
                 type, enabled,
                 created_at, updated_at
          FROM knowledge
          WHERE enabled = TRUE
          ORDER BY id DESC
        `);

      res.json({
        success:
          true,
        knowledge:
          rows
      });
    } catch (e) {
      console.error(
        "KNOWLEDGE GET ERROR:",
        e
      );

      res
        .status(500)
        .json({
          error:
            "Bilimlarni olishda xato"
        });
    }
  }
);

app.post(
  "/api/knowledge",
  requireAdmin,
  async (
    req,
    res
  ) => {
    try {
      const {
        title = "",
        question = "",
        answer = "",
        text = "",
        type = "general",
        enabled = true
      } =
        req.body || {};

      const raw =
        String(
          text ||
          answer ||
          ""
        ).trim();

      if (!raw) {
        return res
          .status(400)
          .json({
            error:
              "Bilim matni bo'sh"
          });
      }

      const rows =
        await db(
          `INSERT INTO knowledge
           (title, question, answer, raw_text,
            type, enabled)
           VALUES
           ($1, $2, $3, $4, $5, $6)
           RETURNING id, title, question,
                     answer, raw_text AS text,
                     type, enabled,
                     created_at, updated_at`,
          [
            String(
              title
            ).trim(),

            String(
              question
            ).trim(),

            String(
              answer ||
              raw
            ).trim(),

            raw,

            String(
              type
            ),

            Boolean(
              enabled
            )
          ]
        );

      res
        .status(201)
        .json({
          success:
            true,
          knowledge:
            rows[0]
        });
    } catch (e) {
      console.error(
        "KNOWLEDGE ADD ERROR:",
        e
      );

      res
        .status(500)
        .json({
          error:
            "Bilimni saqlashda xato"
        });
    }
  }
);

app.delete(
  "/api/knowledge/:id",
  requireAdmin,
  async (
    req,
    res
  ) => {
    try {
      const id =
        Number(
          req.params.id
        );

      if (
        !Number.isSafeInteger(
          id
        ) ||
        id <= 0
      ) {
        return res
          .status(400)
          .json({
            error:
              "Bilim ID noto‘g‘ri"
          });
      }

      const rows =
        await db(
          `DELETE FROM knowledge
           WHERE id = $1
           RETURNING id`,
          [id]
        );

      if (
        !rows.length
      ) {
        return res
          .status(404)
          .json({
            error:
              "Bilim topilmadi"
          });
      }

      res.json({
        success:
          true
      });
    } catch (e) {
      console.error(
        "KNOWLEDGE DELETE ERROR:",
        e
      );

      res
        .status(500)
        .json({
          error:
            "Bilimni o'chirishda xato"
        });
    }
  }
);

app.delete(
  "/api/knowledge/all",
  requireAdmin,
  async (
    req,
    res
  ) => {
    try {
      await db(
        `TRUNCATE TABLE knowledge
         RESTART IDENTITY`
      );

      res.json({
        success:
          true,

        message:
          "Barcha bilimlar o‘chirildi"
      });
    } catch (e) {
      console.error(
        "KNOWLEDGE DELETE ALL ERROR:",
        e
      );

      res
        .status(500)
        .json({
          error:
            "Barcha bilimlarni o‘chirishda xato"
        });
    }
  }
);

app.get(
  "/api/admin/knowledge",
  requireAdmin,
  async (
    req,
    res
  ) => {
    const rows =
      await db(`
        SELECT id, title, question,
               answer, raw_text AS text,
               type, enabled,
               created_at, updated_at
        FROM knowledge
        ORDER BY id DESC
      `);

    res.json({
      success:
        true,
      knowledge:
        rows
    });
  }
);

// ============================================================
// SETTINGS / PROFILE
// ============================================================

app.get(
  "/api/settings",
  requireAdmin,
  async (
    req,
    res
  ) => {
    const s =
      await getSettings();

    res.json({
      success:
        true,
      settings:
        s
    });
  }
);

app.put(
  "/api/settings",
  requireAdmin,
  async (
    req,
    res
  ) => {
    try {
      const s =
        req.body || {};

      await db(
        `
        UPDATE settings SET
          agent_name = $1,
          brand_name = $2,
          role = $3,
          instruction = $4,
          must_rules = $5,
          never_rules = $6,
          customer_rules = $7,
          language = $8,
          tone = $9,
          emoji = $10,
          answer_length = $11,
          greeting = $12,
          ask_style = $13,
          model = $14,
          temperature = $15,
          max_tokens = $16,
          updated_at = NOW()
        WHERE id = 1
      `,
        [
          s.agent_name ||
            "Qamir",

          s.brand_name ||
            "Qamir AI",

          s.role ||
            "",

          s.instruction ||
            "",

          s.must_rules ||
            "",

          s.never_rules ||
            "",

          s.customer_rules ||
            "",

          s.language ||
            "O‘zbek",

          s.tone ||
            "Samimiy",

          s.emoji ||
            "some",

          s.answer_length ||
            "O‘rtacha",

          s.greeting ||
            "Salom! Men Qamir AI. Sizga qanday yordam beray?",

          s.ask_style ||
            "",

          s.model ||
            "gemini-2.5-flash",

          Number(
            s.temperature ??
            0.7
          ),

          Number(
            s.max_tokens ??
            1024
          )
        ]
      );

      res.json({
        success:
          true
      });
    } catch (e) {
      console.error(
        "SETTINGS ERROR:",
        e
      );

      res
        .status(500)
        .json({
          error:
            "Sozlamalarni saqlashda xato"
        });
    }
  }
);

app.put(
  "/api/profile",
  requireUser,
  async (
    req,
    res
  ) => {
    try {
      const {
        email = "",
        birth_date = "",
        city = "",
        avatar = "",
        password = ""
      } =
        req.body || {};

      if (
        password &&
        String(
          password
        ).length < 6
      ) {
        return res
          .status(400)
          .json({
            error:
              "Yangi parol kamida 6 belgi bo'lsin"
          });
      }

      if (password) {
        await db(
          `
          UPDATE users
          SET
            email = $1,
            birth_date = $2,
            city = $3,
            avatar = $4,
            password_hash = $5,
            last_seen = NOW()
          WHERE id = $6
        `,
          [
            String(
              email
            ).trim(),

            String(
              birth_date
            ),

            String(
              city
            ).trim(),

            String(
              avatar ||
              "assets/avatar.svg"
            ),

            hashPassword(
              password
            ),

            req.user.id
          ]
        );
      } else {
        await db(
          `
          UPDATE users
          SET
            email = $1,
            birth_date = $2,
            city = $3,
            avatar = $4,
            last_seen = NOW()
          WHERE id = $5
        `,
          [
            String(
              email
            ).trim(),

            String(
              birth_date
            ),

            String(
              city
            ).trim(),

            String(
              avatar ||
              "assets/avatar.svg"
            ),

            req.user.id
          ]
        );
      }

      const rows =
        await db(
          `
          SELECT
            id,
            username,
            email,
            birth_date,
            city,
            avatar,
            is_admin,
            created_at,
            last_seen
          FROM users
          WHERE id = $1
        `,
          [
            req.user.id
          ]
        );

      res.json({
        success:
          true,

        user:
          safeUser(
            rows[0]
          )
      });
    } catch (e) {
      console.error(
        "PROFILE ERROR:",
        e
      );

      res
        .status(500)
        .json({
          error:
            "Profilni saqlashda xato"
        });
    }
  }
);

// ============================================================
// CHAT
// ============================================================

app.get(
  "/api/chat/history",
  requireUser,
  async (
    req,
    res
  ) => {
    const rows =
      await db(
        `
        SELECT id, sender, text,
               created_at
        FROM messages
        WHERE user_id = $1
        ORDER BY created_at ASC
        LIMIT 300
      `,
        [
          req.user.id
        ]
      );

    res.json({
      success:
        true,
      messages:
        rows
    });
  }
);

app.post(
  "/api/chat",
  requireUser,
  async (
    req,
    res
  ) => {
    try {
      const text =
        String(
          req.body?.message ||
          req.body?.text ||
          ""
        ).trim();

      if (!text) {
        return res
          .status(400)
          .json({
            error:
              "Xabar bo'sh"
          });
      }

      const previous =
        await db(
          `
          SELECT sender, text
          FROM messages
          WHERE user_id = $1
          ORDER BY created_at DESC
          LIMIT 40
        `,
          [
            req.user.id
          ]
        );

      const history =
        previous.reverse();

      await db(
        `INSERT INTO messages
         (user_id, sender, text)
         VALUES ($1, 'user', $2)`,
        [
          req.user.id,
          text
        ]
      );

      await db(
        `UPDATE users
         SET last_seen = NOW()
         WHERE id = $1`,
        [
          req.user.id
        ]
      );

      // ========================================================
      // 0. SANA / VAQT
      // ========================================================

      const dateTimeAnswer =
        getDateTimeAnswer(
          text
        );

      if (
        dateTimeAnswer
      ) {
        const saved =
          await db(
            `
            INSERT INTO messages
              (user_id, sender, text)
            VALUES
              ($1, 'assistant', $2)
            RETURNING
              id, sender, text,
              created_at
          `,
            [
              req.user.id,
              dateTimeAnswer.answer
            ]
          );

        return res.json({
          success:
            true,

          answer:
            dateTimeAnswer.answer,

          source:
            dateTimeAnswer.source,

          matched_knowledge:
            [],

          message:
            saved[0]
        });
      }

      // ========================================================
      // 1. CALCULATOR
      // ========================================================

      const calc =
        tryCalculate(
          text
        );

      if (calc) {
        const saved =
          await db(
            `
            INSERT INTO messages
              (user_id, sender, text)
            VALUES
              ($1, 'assistant', $2)
            RETURNING
              id, sender, text,
              created_at
          `,
            [
              req.user.id,
              calc.answer
            ]
          );

        return res.json({
          success:
            true,

          answer:
            calc.answer,

          source:
            "calculator",

          matched_knowledge:
            [],

          calculation: {
            expression:
              calc.expression,

            result:
              calc.result
          },

          message:
            saved[0]
        });
      }

      // ========================================================
      // 2. TRANSLATOR
      // ========================================================

      const translationRequest =
        findTranslationIntent(
          text
        );

      if (
        translationRequest
      ) {
        try {
          const translated =
            await tryTranslate(
              text
            );

          if (
            translated
          ) {
            const saved =
              await db(
                `
                INSERT INTO messages
                  (user_id, sender, text)
                VALUES
                  ($1, 'assistant', $2)
                RETURNING
                  id, sender, text,
                  created_at
              `,
                [
                  req.user.id,
                  translated.translated
                ]
              );

            return res.json({
              success:
                true,

              answer:
                translated.translated,

              source:
                "translator",

              matched_knowledge:
                [],

              translation: {
                source_text:
                  translated.sourceText,

                target_language:
                  translated.targetCode,

                detected_source_language:
                  translated.detectedSource ||
                  null
              },

              message:
                saved[0]
            });
          }
        } catch (e) {
          console.error(
            "TRANSLATOR ERROR:",
            e.message
          );

          const saved =
            await db(
              `
              INSERT INTO messages
                (user_id, sender, text)
              VALUES
                ($1, 'assistant', $2)
              RETURNING
                id, sender, text,
                created_at
            `,
              [
                req.user.id,
                "Tarjima xizmati hozircha javob bermadi. Iltimos, birozdan keyin yana urinib ko‘ring."
              ]
            );

          return res.json({
            success:
              true,

            answer:
              "Tarjima xizmati hozircha javob bermadi. Iltimos, birozdan keyin yana urinib ko‘ring.",

            source:
              "translator_error",

            error:
              e.message,

            matched_knowledge:
              [],

            message:
              saved[0]
          });
        }
      }

      // ========================================================
      // 3. QAMIR BILIM BAZASI
      // ========================================================

      const matches =
        await findKnowledge(
          text,
          8
        );

      const trusted =
        chooseKnowledgeAnswer(
          matches
        );

      let answer =
        null;

      let source =
        "unknown";

      if (trusted) {
        answer =
          String(
            trusted.answer ||
            ""
          ).trim();

        source =
          "qamir_knowledge";
      }

      // ========================================================
      // 4. WIKIPEDIA
      // ========================================================

      if (!answer) {
        try {
          console.log(
            "Wikipedia tekshirilmoqda:",
            text
          );

          const wiki =
            await searchWikipedia(
              text
            );

          if (wiki) {
            const parts =
              [];

            if (
              wiki.description
            ) {
              parts.push(
                wiki.description
              );
            }

            if (
              wiki.extract
            ) {
              parts.push(
                wiki.extract
              );
            }

            const wikiText =
              parts
                .join(
                  "\n\n"
                )
                .trim();

            if (
              wikiText
            ) {
              answer =
                `${wiki.title}\n\n` +
                `${wikiText}`;

              source =
                "wikipedia";

              console.log(
                "Wikipedia javobi tayyor:",
                wiki.title
              );
            }
          }
        } catch (e) {
          console.error(
            "WIKIPEDIA ERROR:",
            e
          );
        }
      }

      // ========================================================
      // 5. GEMINI
      // ========================================================

      if (!answer) {
        const usefulContext =
          matches
            .filter(
              x =>
                x.score >= 75
            )
            .slice(
              0,
              4
            );

        try {
          answer =
            await askGemini(
              text,
              history,
              usefulContext
            );

          if (answer) {
            source =
              "gemini_assist";
          }
        } catch (e) {
          console.error(
            "GEMINI ERROR:",
            e.message
          );
        }
      }

      // ========================================================
      // 6. NO ANSWER
      // ========================================================

      if (!answer) {
        answer =
          "Bu savol bo‘yicha Qamir AI bilim bazasida hozircha yetarli ma’lumot yo‘q.";

        source =
          "no_knowledge";
      }

      const saved =
        await db(
          `
          INSERT INTO messages
            (user_id, sender, text)
          VALUES
            ($1, 'assistant', $2)
          RETURNING
            id, sender, text,
            created_at
        `,
          [
            req.user.id,
            answer
          ]
        );

      res.json({
        success:
          true,

        answer,

        source,

        matched_knowledge:
          matches
            .slice(
              0,
              3
            )
            .map(
              x => ({
                id:
                  x.id,
                title:
                  x.title,
                question:
                  x.question,
                score:
                  x.score
              })
            ),

        message:
          saved[0]
      });

    } catch (e) {
      console.error(
        "CHAT ERROR:",
        e
      );

      res
        .status(500)
        .json({
          error:
            "Chat server xatosi"
        });
    }
  }
);

// ============================================================
// ADMIN STATS / IMPROVEMENT
// ============================================================

app.get(
  "/api/admin/stats",
  requireAdmin,
  async (
    req,
    res
  ) => {
    const [m, k, u] =
      await Promise.all([
        db(`
          SELECT COUNT(*)::int AS n
          FROM messages
        `),

        db(`
          SELECT COUNT(*)::int AS n
          FROM knowledge
          WHERE enabled = TRUE
        `),

        db(`
          SELECT COUNT(*)::int AS n
          FROM users
        `)
      ]);

    res.json({
      success:
        true,

      messages:
        m[0].n,

      knowledge:
        k[0].n,

      users:
        u[0].n
    });
  }
);

app.get(
  "/api/admin/improve",
  requireAdmin,
  async (
    req,
    res
  ) => {
    const rows =
      await db(`
        SELECT
          id,
          title,
          text,
          status,
          created_at
        FROM suggestions
        WHERE status = 'pending'
        ORDER BY id DESC
      `);

    res.json({
      success:
        true,

      suggestions:
        rows
    });
  }
);

app.post(
  "/api/admin/improve/analyze",
  requireAdmin,
  async (
    req,
    res
  ) => {
    const rows =
      await db(`
        SELECT text
        FROM messages
        WHERE sender = 'user'
        ORDER BY id DESC
        LIMIT 500
      `);

    const counts =
      new Map();

    for (
      const row
      of rows
    ) {
      const ws =
        tokenize(
          row.text
        )
          .filter(
            w =>
              w.length >= 5
          );

      for (
        const w
        of ws
      ) {
        counts.set(
          w,
          (
            counts.get(w) ||
            0
          ) + 1
        );
      }
    }

    const top =
      [
        ...counts.entries()
      ]
        .sort(
          (a, b) =>
            b[1] -
            a[1]
        )
        .slice(
          0,
          10
        );

    for (
      const [
        topic,
        count
      ]
      of top
    ) {
      if (
        count < 3
      ) {
        continue;
      }

      const exists =
        await db(
          `SELECT id
           FROM knowledge
           WHERE LOWER(
             question || ' ' ||
             title || ' ' ||
             answer
           ) LIKE
             '%' ||
             LOWER($1) ||
             '%'
           LIMIT 1`,
          [
            topic
          ]
        );

      if (
        !exists.length
      ) {
        await db(
          `INSERT INTO suggestions
             (title, text)
           VALUES
             ($1, $2)`,
          [
            "Ko‘p so‘raladigan mavzu",

            `Mijozlar “${topic}” mavzusini ${count} marta tilga oldi. Shu mavzu bo‘yicha aniq bilim qo‘shish foydali.`
          ]
        );
      }
    }

    res.json({
      success:
        true
    });
  }
);

app.post(
  "/api/admin/improve/:id/approve",
  requireAdmin,
  async (
    req,
    res
  ) => {
    const rows =
      await db(
        `SELECT id, title, text
         FROM suggestions
         WHERE id = $1
           AND status = 'pending'`,
        [
          Number(
            req.params.id
          )
        ]
      );

    if (
      !rows.length
    ) {
      return res
        .status(404)
        .json({
          error:
            "Taklif topilmadi"
        });
    }

    const s =
      rows[0];

    await db(
      `INSERT INTO knowledge
        (title, question, answer,
         raw_text, type)
       VALUES
        ($1, '', $2, $2, 'general')`,
      [
        s.title,
        s.text
      ]
    );

    await db(
      `UPDATE suggestions
       SET status = 'approved'
       WHERE id = $1`,
      [
        s.id
      ]
    );

    res.json({
      success:
        true
    });
  }
);

app.post(
  "/api/admin/improve/:id/reject",
  requireAdmin,
  async (
    req,
    res
  ) => {
    await db(
      `UPDATE suggestions
       SET status = 'rejected'
       WHERE id = $1`,
      [
        Number(
          req.params.id
        )
      ]
    );

    res.json({
      success:
        true
    });
  }
);

// ============================================================
// STATIC FRONTEND
// ============================================================

app.use(
  express.static(
    __dirname
  )
);

initDb()
  .then(() => {
    app.listen(
      PORT,
      "0.0.0.0",
      () => {
        console.log(
          `Qamir AI server running on port ${PORT}`
        );

        console.log(
          "PostgreSQL: connected"
        );

        console.log(
          `Gemini API key: ${
            process.env
              .GEMINI_API_KEY
              ? "configured"
              : "NOT configured"
          }`
        );

        console.log(
          `Gemini model: ${
            process.env.GEMINI_MODEL ||
            "gemini-2.5-flash"
          }`
        );

        console.log(
          "Advanced calculator: enabled"
        );

        console.log(
          "Translator: Google public + LibreTranslate fallback enabled"
        );

        console.log(
          "Translator API key: not required"
        );

        console.log(
          "Uzbekistan date/time: enabled"
        );

        console.log(
          "Wikipedia search: enabled"
        );

        console.log(
          "Knowledge search: strict matching enabled"
        );
      }
    );
  })
  .catch(
    error => {
      console.error(
        "DATABASE INIT ERROR:",
        error
      );

      process.exit(1);
    }
  );

process.on(
  "SIGTERM",
  async () => {
    await pool.end();
    process.exit(0);
  }
);

process.on(
  "SIGINT",
  async () => {
    await pool.end();
    process.exit(0);
  }
);
