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
  return crypto.createHash("sha256").update(String(password)).digest("hex");
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

  const setting = await db(`SELECT id FROM settings WHERE id = 1`);
  if (!setting.length) {
    await db(`INSERT INTO settings (id) VALUES (1)`);
  }

  const adminPassword = process.env.ADMIN_PASSWORD || "Al-qamir";
  const adminHash = hashPassword(adminPassword);

  const adminRows = await db(
    `SELECT id FROM users WHERE LOWER(username) = 'admin' LIMIT 1`
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
      `UPDATE users SET password_hash = $1, is_admin = TRUE
       WHERE LOWER(username) = 'admin'`,
      [adminHash]
    );
    console.log("Admin account yangilandi.");
  }

  console.log("Database tayyor.");
}

function bearer(req) {
  const h = req.headers.authorization || "";
  return h.startsWith("Bearer ") ? h.slice(7) : "";
}

async function userFromRequest(req) {
  const token = bearer(req);
  if (!token) return null;

  const rows = await db(
    `SELECT id, username, email, birth_date, city, avatar,
            is_admin, created_at, last_seen
     FROM users WHERE id = $1 LIMIT 1`,
    [Number(token)]
  );

  return rows[0] || null;
}

async function requireUser(req, res, next) {
  try {
    const user = await userFromRequest(req);
    if (!user) return res.status(401).json({ error: "Kirish talab qilinadi" });
    req.user = user;
    next();
  } catch (e) {
    console.error("AUTH ERROR:", e);
    res.status(500).json({ error: "Server xatosi" });
  }
}

async function requireAdmin(req, res, next) {
  try {
    const user = await userFromRequest(req);
    if (!user || !user.is_admin) {
      return res.status(403).json({ error: "Faqat Admin uchun" });
    }
    req.user = user;
    next();
  } catch (e) {
    console.error("ADMIN ERROR:", e);
    res.status(500).json({ error: "Server xatosi" });
  }
}

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stem(word) {
  return String(word || "").replace(
    /(laringiz|laring|laring|ning|dan|dagi|dagi|ga|ka|qa|ni|da|de|di|dir|mi|mu|siz|man|men|lar)$/i,
    ""
  );
}

function words(text) {
  return [...new Set(
    normalize(text)
      .split(/\s+/)
      .map(stem)
      .filter(w => w.length >= 2)
  )];
}

function scoreKnowledge(query, item) {
  const q = normalize(query);
  const qw = words(query);
  const question = normalize(item.question);
  const title = normalize(item.title);
  const answer = normalize(item.answer);

  let score = 0;

  if (question && (q === question || q.includes(question) || question.includes(q))) {
    score += 100;
  }

  for (const w of qw) {
    if (question.includes(w)) score += 24;
    else if (title.includes(w)) score += 18;
    else if (answer.includes(w)) score += 3;
  }

  const longWords = qw.filter(w => w.length >= 4);
  const hits = longWords.filter(w => question.includes(w) || title.includes(w)).length;
  score += hits * 12;

  return score;
}

async function findKnowledge(query, limit = 5) {
  const rows = await db(`
    SELECT id, title, question, answer, raw_text, type, enabled
    FROM knowledge
    WHERE enabled = TRUE
    ORDER BY id DESC
  `);

  return rows
    .map(item => ({ ...item, score: scoreKnowledge(query, item) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

async function getSettings() {
  const rows = await db(`SELECT * FROM settings WHERE id = 1`);
  return rows[0] || {};
}

async function askGemini(userText, history, knowledge) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;

  const settings = await getSettings();
  const model = process.env.GEMINI_MODEL || settings.model || "gemini-2.5-flash";

  const context = knowledge.map((x, i) =>
    `[QAMIR BILIMI ${i + 1}]
Savol: ${x.question || x.title}
Javob: ${x.answer}`
  ).join("\n\n");

  const systemPrompt = `
Siz Qamir AI nomli shaxsiy sun'iy intellekt yordamchisisiz.

ASOSIY TAMOYIL:
Qamir AI ning asosiy manbasi Admin bergan bilimlardir.
Gemini faqat yordamchi vosita. Bilimlarda aniq javob mavjud bo'lsa, shu bilimga tayaning.
Bilimlarda javob yetarli bo'lmasa, mavjud bilimlarni buzmasdan javobni shakllantiring.
Bilimda ma'lumot bo'lmasa, faktni o'ylab topmang.

AGENT ROLI:
${settings.role || ""}

ASOSIY KO'RSATMA:
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
Bilim matnini to'liq ko'chirmang.
Savolga mos tabiiy javob bering.
Agar ma'lumot yetarli bo'lmasa, buni ochiq ayting.

QAMIR BILIMLARI:
${context || "(Mos bilim topilmadi.)"}
`;

  const contents = (history || []).slice(-18).map(m => ({
    role: m.sender === "assistant" ? "model" : "user",
    parts: [{ text: String(m.text) }]
  }));

  contents.push({
    role: "user",
    parts: [{ text: String(userText) }]
  });

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents,
        generationConfig: {
          temperature: Math.max(0, Math.min(2, Number(settings.temperature ?? 0.7))),
          maxOutputTokens: Math.max(64, Math.min(8192, Number(settings.max_tokens ?? 1024)))
        }
      })
    }
  );

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error?.message || `Gemini HTTP ${response.status}`);
  }

  return (data?.candidates?.[0]?.content?.parts || [])
    .map(p => p.text || "")
    .join("")
    .trim() || null;
}

app.get("/api/health", async (req, res) => {
  try {
    await db("SELECT 1");
    res.json({
      ok: true,
      database: "connected",
      gemini: Boolean(process.env.GEMINI_API_KEY),
      model: process.env.GEMINI_MODEL || "gemini-2.5-flash"
    });
  } catch (e) {
    res.status(500).json({ ok: false, database: "error", error: e.message });
  }
});

async function register(req, res) {
  try {
    const { username, email = "", password } = req.body || {};
    const un = String(username || "").trim();

    if (un.length < 3 || String(password || "").length < 6) {
      return res.status(400).json({
        error: "Login kamida 3, parol kamida 6 belgidan iborat bo'lsin"
      });
    }

    const rows = await db(
      `INSERT INTO users (username, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, username, email, birth_date, city, avatar,
                 is_admin, created_at, last_seen`,
      [un, String(email).trim(), hashPassword(password)]
    );

    res.status(201).json({
      success: true,
      user: safeUser(rows[0]),
      token: String(rows[0].id)
    });
  } catch (e) {
    if (e.code === "23505") {
      return res.status(409).json({ error: "Bu login allaqachon mavjud" });
    }
    console.error("REGISTER ERROR:", e);
    res.status(500).json({ error: "Ro'yxatdan o'tishda server xatosi" });
  }
}

async function login(req, res) {
  try {
    const { username, password } = req.body || {};
    const rows = await db(
      `SELECT id, username, email, birth_date, city, avatar,
              is_admin, created_at, last_seen
       FROM users
       WHERE LOWER(username) = LOWER($1)
         AND password_hash = $2
       LIMIT 1`,
      [String(username || "").trim(), hashPassword(password || "")]
    );

    if (!rows.length) {
      return res.status(401).json({ error: "Login yoki parol noto'g'ri" });
    }

    await db(`UPDATE users SET last_seen = NOW() WHERE id = $1`, [rows[0].id]);

    res.json({
      success: true,
      user: safeUser(rows[0]),
      token: String(rows[0].id)
    });
  } catch (e) {
    console.error("LOGIN ERROR:", e);
    res.status(500).json({ error: "Kirishda server xatosi" });
  }
}

app.post("/api/auth/register", register);
app.post("/api/register", register);
app.post("/api/auth/login", login);
app.post("/api/login", login);

app.get("/api/me", requireUser, async (req, res) => {
  res.json({ success: true, user: safeUser(req.user) });
});

app.get("/api/knowledge", requireUser, async (req, res) => {
  try {
    const rows = await db(`
      SELECT id, title, question, answer, raw_text AS text,
             type, enabled, created_at, updated_at
      FROM knowledge
      WHERE enabled = TRUE
      ORDER BY id DESC
    `);
    res.json({ success: true, knowledge: rows });
  } catch (e) {
    console.error("KNOWLEDGE GET ERROR:", e);
    res.status(500).json({ error: "Bilimlarni olishda xato" });
  }
});

app.post("/api/knowledge", requireAdmin, async (req, res) => {
  try {
    const {
      title = "",
      question = "",
      answer = "",
      text = "",
      type = "general",
      enabled = true
    } = req.body || {};

    const raw = String(text || answer || "").trim();
    if (!raw) return res.status(400).json({ error: "Bilim matni bo'sh" });

    const rows = await db(
      `INSERT INTO knowledge
       (title, question, answer, raw_text, type, enabled)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, title, question, answer, raw_text AS text,
                 type, enabled, created_at, updated_at`,
      [
        String(title).trim(),
        String(question).trim(),
        String(answer || raw).trim(),
        raw,
        String(type),
        Boolean(enabled)
      ]
    );

    res.status(201).json({ success: true, knowledge: rows[0] });
  } catch (e) {
    console.error("KNOWLEDGE ADD ERROR:", e);
    res.status(500).json({ error: "Bilimni saqlashda xato" });
  }
});

app.delete("/api/knowledge/:id", requireAdmin, async (req, res) => {
  try {
    await db(`DELETE FROM knowledge WHERE id = $1`, [Number(req.params.id)]);
    res.json({ success: true });
  } catch (e) {
    console.error("KNOWLEDGE DELETE ERROR:", e);
    res.status(500).json({ error: "Bilimni o'chirishda xato" });
  }
});

app.get("/api/admin/knowledge", requireAdmin, async (req, res) => {
  const rows = await db(`
    SELECT id, title, question, answer, raw_text AS text,
           type, enabled, created_at, updated_at
    FROM knowledge ORDER BY id DESC
  `);
  res.json({ success: true, knowledge: rows });
});

app.get("/api/settings", requireAdmin, async (req, res) => {
  const s = await getSettings();
  res.json({ success: true, settings: s });
});

app.put("/api/settings", requireAdmin, async (req, res) => {
  try {
    const s = req.body || {};
    await db(`
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
    `, [
      s.agent_name || "Qamir",
      s.brand_name || "Qamir AI",
      s.role || "",
      s.instruction || "",
      s.must_rules || "",
      s.never_rules || "",
      s.customer_rules || "",
      s.language || "O‘zbek",
      s.tone || "Samimiy",
      s.emoji || "some",
      s.answer_length || "O‘rtacha",
      s.greeting || "Salom! Men Qamir AI. Sizga qanday yordam beray?",
      s.ask_style || "",
      s.model || "gemini-2.5-flash",
      Number(s.temperature ?? 0.7),
      Number(s.max_tokens ?? 1024)
    ]);

    res.json({ success: true });
  } catch (e) {
    console.error("SETTINGS ERROR:", e);
    res.status(500).json({ error: "Sozlamalarni saqlashda xato" });
  }
});

app.put("/api/profile", requireUser, async (req, res) => {
  try {
    const { email = "", birth_date = "", city = "", avatar = "", password = "" } = req.body || {};

    if (password && String(password).length < 6) {
      return res.status(400).json({ error: "Yangi parol kamida 6 belgi bo'lsin" });
    }

    if (password) {
      await db(`
        UPDATE users
        SET email = $1, birth_date = $2, city = $3, avatar = $4,
            password_hash = $5, last_seen = NOW()
        WHERE id = $6
      `, [
        String(email).trim(),
        String(birth_date),
        String(city).trim(),
        String(avatar || "assets/avatar.svg"),
        hashPassword(password),
        req.user.id
      ]);
    } else {
      await db(`
        UPDATE users
        SET email = $1, birth_date = $2, city = $3, avatar = $4,
            last_seen = NOW()
        WHERE id = $5
      `, [
        String(email).trim(),
        String(birth_date),
        String(city).trim(),
        String(avatar || "assets/avatar.svg"),
        req.user.id
      ]);
    }

    const rows = await db(`
      SELECT id, username, email, birth_date, city, avatar,
             is_admin, created_at, last_seen
      FROM users WHERE id = $1
    `, [req.user.id]);

    res.json({ success: true, user: safeUser(rows[0]) });
  } catch (e) {
    console.error("PROFILE ERROR:", e);
    res.status(500).json({ error: "Profilni saqlashda xato" });
  }
});

app.get("/api/chat/history", requireUser, async (req, res) => {
  const rows = await db(`
    SELECT id, sender, text, created_at
    FROM messages
    WHERE user_id = $1
    ORDER BY created_at ASC
    LIMIT 300
  `, [req.user.id]);

  res.json({ success: true, messages: rows });
});

app.post("/api/chat", requireUser, async (req, res) => {
  try {
    const text = String(req.body?.message || req.body?.text || "").trim();
    if (!text) return res.status(400).json({ error: "Xabar bo'sh" });

    const previous = await db(`
      SELECT sender, text
      FROM messages
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 40
    `, [req.user.id]);

    const history = previous.reverse();

    await db(
      `INSERT INTO messages (user_id, sender, text)
       VALUES ($1, 'user', $2)`,
      [req.user.id, text]
    );

    await db(`UPDATE users SET last_seen = NOW() WHERE id = $1`, [req.user.id]);

    const matches = await findKnowledge(text, 5);
    let answer = null;
    let source = "unknown";

    if (matches.length && matches[0].score >= 28) {
      answer = matches[0].answer.trim();
      source = "qamir_knowledge";
    } else {
      try {
        answer = await askGemini(text, history, matches);
        if (answer) source = "gemini_assist";
      } catch (e) {
        console.error("GEMINI ERROR:", e.message);
      }
    }

    if (!answer) {
      answer =
        "Bu savol bo‘yicha Qamir AI bilim bazasida hozircha yetarli ma’lumot yo‘q.";
      source = "no_knowledge";
    }

    const saved = await db(`
      INSERT INTO messages (user_id, sender, text)
      VALUES ($1, 'assistant', $2)
      RETURNING id, sender, text, created_at
    `, [req.user.id, answer]);

    res.json({
      success: true,
      answer,
      source,
      matched_knowledge: matches.slice(0, 3).map(x => ({
        id: x.id,
        title: x.title,
        score: x.score
      })),
      message: saved[0]
    });
  } catch (e) {
    console.error("CHAT ERROR:", e);
    res.status(500).json({ error: "Chat server xatosi" });
  }
});

app.get("/api/admin/stats", requireAdmin, async (req, res) => {
  const [m, k, u] = await Promise.all([
    db(`SELECT COUNT(*)::int AS n FROM messages`),
    db(`SELECT COUNT(*)::int AS n FROM knowledge WHERE enabled = TRUE`),
    db(`SELECT COUNT(*)::int AS n FROM users`)
  ]);

  res.json({
    success: true,
    messages: m[0].n,
    knowledge: k[0].n,
    users: u[0].n
  });
});

app.get("/api/admin/improve", requireAdmin, async (req, res) => {
  const rows = await db(`
    SELECT id, title, text, status, created_at
    FROM suggestions
    WHERE status = 'pending'
    ORDER BY id DESC
  `);
  res.json({ success: true, suggestions: rows });
});

app.post("/api/admin/improve/analyze", requireAdmin, async (req, res) => {
  const rows = await db(`
    SELECT text
    FROM messages
    WHERE sender = 'user'
    ORDER BY id DESC
    LIMIT 500
  `);

  const counts = new Map();

  for (const row of rows) {
    const ws = words(row.text).filter(w => w.length >= 5);
    for (const w of ws) counts.set(w, (counts.get(w) || 0) + 1);
  }

  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  for (const [topic, count] of top) {
    if (count < 3) continue;

    const exists = await db(
      `SELECT id FROM knowledge
       WHERE LOWER(question || ' ' || title || ' ' || answer) LIKE '%' || LOWER($1) || '%'
       LIMIT 1`,
      [topic]
    );

    if (!exists.length) {
      await db(
        `INSERT INTO suggestions (title, text)
         VALUES ($1, $2)`,
        [
          "Ko‘p so‘raladigan mavzu",
          `Mijozlar “${topic}” mavzusini ${count} marta tilga oldi. Shu mavzu bo‘yicha aniq bilim qo‘shish foydali.`
        ]
      );
    }
  }

  res.json({ success: true });
});

app.post("/api/admin/improve/:id/approve", requireAdmin, async (req, res) => {
  const rows = await db(
    `SELECT id, title, text FROM suggestions WHERE id = $1 AND status = 'pending'`,
    [Number(req.params.id)]
  );

  if (!rows.length) return res.status(404).json({ error: "Taklif topilmadi" });

  const s = rows[0];

  await db(
    `INSERT INTO knowledge (title, question, answer, raw_text, type)
     VALUES ($1, '', $2, $2, 'general')`,
    [s.title, s.text]
  );

  await db(`UPDATE suggestions SET status = 'approved' WHERE id = $1`, [s.id]);
  res.json({ success: true });
});

app.post("/api/admin/improve/:id/reject", requireAdmin, async (req, res) => {
  await db(
    `UPDATE suggestions SET status = 'rejected' WHERE id = $1`,
    [Number(req.params.id)]
  );
  res.json({ success: true });
});

app.use(express.static(__dirname));

initDb()
  .then(() => {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Qamir AI server running on port ${PORT}`);
      console.log(`PostgreSQL: connected`);
      console.log(`Gemini API key: ${process.env.GEMINI_API_KEY ? "configured" : "NOT configured"}`);
      console.log(`Gemini model: ${process.env.GEMINI_MODEL || "gemini-2.5-flash"}`);
    });
  })
  .catch(error => {
    console.error("DATABASE INIT ERROR:", error);
    process.exit(1);
  });
