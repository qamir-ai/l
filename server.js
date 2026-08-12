require("dotenv").config();

const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");

const app = express();
const PORT = Number(process.env.PORT) || 10000;

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");

for (const dir of [DATA_DIR, UPLOAD_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

const FILES = {
  users: path.join(DATA_DIR, "users.json"),
  messages: path.join(DATA_DIR, "messages.json"),
  settings: path.join(DATA_DIR, "settings.json")
};

const DEFAULT_SETTINGS = {
  siteName: "Qamir AI",
  assistantName: "Qamir",
  systemPrompt:
    "Siz Qamir AI yordamchisisiz. O'zbek tilida xushmuomala, foydali va aniq gapiring. Foydalanuvchining savoliga tushunarli javob bering.",
  welcome:
    "Salom! Men Qamir AI. Buguningiz yaxshi o'tishi uchun yordam beraman.",
  fallbackMode: true
};

// ADMIN LOGIN — user so'raganidek o'zgartirib bo'lmaydi.
const ADMIN_USERNAME = "Admin";
const ADMIN_PASSWORD = "Al-qamir";

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, JSON.stringify(fallback, null, 2), "utf8");
      return fallback;
    }
    const raw = fs.readFileSync(file, "utf8").trim();
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    console.error("JSON READ ERROR:", file, e);
    return fallback;
  }
}

function writeJson(file, value) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

function users() {
  return readJson(FILES.users, []);
}
function messages() {
  return readJson(FILES.messages, []);
}
function settings() {
  return { ...DEFAULT_SETTINGS, ...readJson(FILES.settings, DEFAULT_SETTINGS) };
}

if (!fs.existsSync(FILES.settings)) writeJson(FILES.settings, DEFAULT_SETTINGS);
if (!fs.existsSync(FILES.users)) writeJson(FILES.users, []);
if (!fs.existsSync(FILES.messages)) writeJson(FILES.messages, []);

function id() {
  return crypto.randomBytes(16).toString("hex");
}

function hash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function safeUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    email: u.email || "",
    fullName: u.fullName || "",
    birthday: u.birthday || "",
    city: u.city || "",
    avatar: u.avatar || "",
    createdAt: u.createdAt,
    lastSeen: u.lastSeen || null
  };
}

function tokenFor(userId) {
  return Buffer.from(`${userId}:${Date.now()}:${crypto.randomBytes(8).toString("hex")}`).toString("base64url");
}

// In-memory sessions. Restarting the server logs users out.
const sessions = new Map();

function authUser(req) {
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const session = sessions.get(token);
  if (!session || session.type !== "user") return null;
  return users().find(u => u.id === session.userId) || null;
}

function authAdmin(req) {
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return false;
  const session = sessions.get(token);
  return !!session && session.type === "admin";
}

function requireUser(req, res, next) {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "Login qilish kerak." });
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  if (!authAdmin(req)) return res.status(403).json({ error: "Admin huquqi kerak." });
  next();
}

// ---------- uploads ----------
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOAD_DIR),
  filename: (_, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString("hex")}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    if (/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error("Faqat JPG, PNG, WEBP yoki GIF rasm yuklang."));
  }
});

app.use("/uploads", express.static(UPLOAD_DIR));

// ---------- health ----------
app.get("/health", (_, res) => {
  res.json({
    ok: true,
    name: "Qamir AI",
    gemini: !!process.env.GEMINI_API_KEY,
    model: process.env.GEMINI_MODEL || "gemini-2.5-flash"
  });
});

// ---------- auth ----------
app.post("/api/register", (req, res) => {
  try {
    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "");
    const email = String(req.body.email || "").trim();

    if (username.length < 3) return res.status(400).json({ error: "Username kamida 3 ta belgi bo'lsin." });
    if (password.length < 6) return res.status(400).json({ error: "Parol kamida 6 ta belgi bo'lsin." });
    if (username.toLowerCase() === ADMIN_USERNAME.toLowerCase()) return res.status(400).json({ error: "Bu username band." });

    const list = users();
    if (list.some(u => u.username.toLowerCase() === username.toLowerCase())) {
      return res.status(409).json({ error: "Bu username allaqachon mavjud." });
    }

    const user = {
      id: id(),
      username,
      email,
      fullName: "",
      birthday: "",
      city: "",
      avatar: "",
      passwordHash: hash(password),
      createdAt: new Date().toISOString(),
      lastSeen: new Date().toISOString()
    };

    list.push(user);
    writeJson(FILES.users, list);

    const token = tokenFor(user.id);
    sessions.set(token, { type: "user", userId: user.id });

    res.status(201).json({ success: true, token, user: safeUser(user) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Ro'yxatdan o'tishda xato." });
  }
});

app.post("/api/login", (req, res) => {
  try {
    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "");

    if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
      const token = tokenFor("ADMIN");
      sessions.set(token, { type: "admin" });
      return res.json({
        success: true,
        admin: true,
        token,
        user: { username: ADMIN_USERNAME, isAdmin: true }
      });
    }

    const user = users().find(
      u => u.username.toLowerCase() === username.toLowerCase() && u.passwordHash === hash(password)
    );

    if (!user) return res.status(401).json({ error: "Username yoki parol noto'g'ri." });

    user.lastSeen = new Date().toISOString();
    writeJson(FILES.users, users());

    const token = tokenFor(user.id);
    sessions.set(token, { type: "user", userId: user.id });

    res.json({ success: true, token, admin: false, user: safeUser(user) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Login xatosi." });
  }
});

app.post("/api/logout", (req, res) => {
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (token) sessions.delete(token);
  res.json({ success: true });
});

app.get("/api/me", requireUser, (req, res) => {
  res.json({ success: true, user: safeUser(req.user) });
});

// ---------- profile ----------
app.put("/api/profile", requireUser, (req, res) => {
  const list = users();
  const user = list.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: "Foydalanuvchi topilmadi." });

  user.fullName = String(req.body.fullName ?? user.fullName).trim().slice(0, 100);
  user.email = String(req.body.email ?? user.email).trim().slice(0, 150);
  user.birthday = String(req.body.birthday ?? user.birthday).trim().slice(0, 20);
  user.city = String(req.body.city ?? user.city).trim().slice(0, 100);

  writeJson(FILES.users, list);
  res.json({ success: true, user: safeUser(user) });
});

app.post("/api/profile/avatar", requireUser, upload.single("avatar"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Rasm tanlanmagan." });

  const list = users();
  const user = list.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: "Foydalanuvchi topilmadi." });

  if (user.avatar) {
    const oldPath = path.join(ROOT, user.avatar.replace(/^\/+/, ""));
    if (oldPath.startsWith(UPLOAD_DIR) && fs.existsSync(oldPath)) {
      try { fs.unlinkSync(oldPath); } catch {}
    }
  }

  user.avatar = `/uploads/${req.file.filename}`;
  writeJson(FILES.users, list);

  res.json({ success: true, user: safeUser(user) });
});

app.put("/api/profile/password", requireUser, (req, res) => {
  const current = String(req.body.currentPassword || "");
  const next = String(req.body.newPassword || "");

  if (next.length < 6) return res.status(400).json({ error: "Yangi parol kamida 6 ta belgi bo'lsin." });

  const list = users();
  const user = list.find(u => u.id === req.user.id);
  if (!user || user.passwordHash !== hash(current)) {
    return res.status(401).json({ error: "Eski parol noto'g'ri." });
  }

  user.passwordHash = hash(next);
  writeJson(FILES.users, list);
  res.json({ success: true });
});

// ---------- chat ----------
function localFallback(text, s, user) {
  const q = text.toLowerCase().trim();
  const custom = s.systemPrompt || DEFAULT_SETTINGS.systemPrompt;

  if (/salom|assalom|hello|hi/.test(q)) {
    return `${s.assistantName || "Qamir"}: Salom${user?.fullName ? ", " + user.fullName : ""}! 😊 Buguningiz yaxshi o'tsin. Sizga nimada yordam beray?`;
  }

  if (/rahmat|raxmat|thanks/.test(q)) {
    return "Arzimaydi! 😊 Yana savolingiz bo'lsa bemalol yozing.";
  }

  if (/bugun|kunim|kayfiyat|yaxshi o't/.test(q)) {
    return "Buguningiz yaxshi o'tsin! 🌟 Ishlaringizni reja bilan qiling, o'zingizga ham biroz dam olishga vaqt qoldiring.";
  }

  if (/isming|kimsan|sen kimsan/.test(q)) {
    return `Men ${s.assistantName || "Qamir"} AI yordamchisiman. Men bilan suhbatlashishingiz, savol berishingiz va foydali maslahat olishingiz mumkin.`;
  }

  return `Men ${s.assistantName || "Qamir"}man. Hozir Gemini API ulanmagan, shuning uchun oddiy ichki yordamchi rejimida ishlayapman.\n\nSavolingiz: "${text}"\n\nAdmin sozlamasidagi ko'rsatma: ${custom}\n\nGemini API key keyin qo'shilsa, men to'liq AI javoblarini Gemini orqali beraman.`;
}

async function askGemini(text, history, user) {
  const s = settings();
  const key = String(process.env.GEMINI_API_KEY || "").trim();

  if (!key) return localFallback(text, s, user);

  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const contents = [];

  for (const m of history.slice(-20)) {
    if (!["user", "assistant"].includes(m.sender)) continue;
    const t = String(m.text || "").trim();
    if (!t) continue;
    contents.push({
      role: m.sender === "assistant" ? "model" : "user",
      parts: [{ text: t }]
    });
  }

  contents.push({ role: "user", parts: [{ text }] });

  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    encodeURIComponent(model) +
    ":generateContent";

  const system = [
    s.systemPrompt,
    `Sizning ismingiz: ${s.assistantName || "Qamir"}.`,
    user?.fullName ? `Foydalanuvchi ismi: ${user.fullName}.` : "",
    user?.birthday ? `Foydalanuvchining tug'ilgan sanasi: ${user.birthday}.` : "",
    user?.city ? `Foydalanuvchi shahri: ${user.city}.` : ""
  ].filter(Boolean).join("\n");

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": key
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents,
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 1200
      }
    })
  });

  const raw = await response.text();
  let data;
  try { data = JSON.parse(raw); } catch { throw new Error("Gemini noto'g'ri JSON qaytardi."); }

  if (!response.ok) {
    throw new Error(data?.error?.message || `Gemini HTTP ${response.status}`);
  }

  const answer = (data?.candidates?.[0]?.content?.parts || [])
    .map(p => p?.text || "")
    .join("")
    .trim();

  if (!answer) throw new Error("Gemini bo'sh javob qaytardi.");
  return answer;
}

app.get("/api/chat/history", requireUser, (req, res) => {
  const rows = messages()
    .filter(m => m.userId === req.user.id)
    .slice(-300);
  res.json({ success: true, messages: rows });
});

app.post("/api/chat", requireUser, async (req, res) => {
  const text = String(req.body.message || "").trim();
  if (!text) return res.status(400).json({ error: "Xabar bo'sh." });

  const all = messages();
  const history = all.filter(m => m.userId === req.user.id).slice(-40);

  const userMsg = {
    id: id(),
    userId: req.user.id,
    sender: "user",
    text,
    createdAt: new Date().toISOString()
  };
  all.push(userMsg);
  writeJson(FILES.messages, all);

  try {
    const answer = await askGemini(text, history, req.user);
    const fresh = messages();

    const aiMsg = {
      id: id(),
      userId: req.user.id,
      sender: "assistant",
      text: answer,
      createdAt: new Date().toISOString()
    };

    fresh.push(aiMsg);
    writeJson(FILES.messages, fresh);

    res.json({ success: true, message: aiMsg, reply: answer });
  } catch (e) {
    console.error("AI ERROR:", e);
    res.status(502).json({
      error: "AI javobida xato.",
      detail: e.message
    });
  }
});

// ---------- admin ----------
app.get("/api/admin/me", requireAdmin, (_, res) => {
  res.json({ success: true, admin: true, username: ADMIN_USERNAME });
});

app.get("/api/admin/settings", requireAdmin, (_, res) => {
  res.json({
    success: true,
    settings: settings(),
    geminiConfigured: !!process.env.GEMINI_API_KEY
  });
});

app.put("/api/admin/settings", requireAdmin, (req, res) => {
  const current = settings();

  const next = {
    siteName: String(req.body.siteName ?? current.siteName).slice(0, 80),
    assistantName: String(req.body.assistantName ?? current.assistantName).slice(0, 80),
    systemPrompt: String(req.body.systemPrompt ?? current.systemPrompt).slice(0, 10000),
    welcome: String(req.body.welcome ?? current.welcome).slice(0, 1000),
    fallbackMode: true
  };

  writeJson(FILES.settings, next);
  res.json({ success: true, settings: next });
});

app.get("/api/admin/users", requireAdmin, (_, res) => {
  const list = users().map(u => ({
    ...safeUser(u),
    messageCount: messages().filter(m => m.userId === u.id).length
  }));
  res.json({ success: true, users: list });
});

app.get("/api/admin/users/:id/messages", requireAdmin, (req, res) => {
  const user = users().find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: "Foydalanuvchi topilmadi." });

  res.json({
    success: true,
    user: safeUser(user),
    messages: messages().filter(m => m.userId === user.id).slice(-1000)
  });
});

app.post("/api/admin/reply", requireAdmin, (req, res) => {
  const userId = String(req.body.userId || "");
  const text = String(req.body.message || "").trim();

  if (!userId || !text) return res.status(400).json({ error: "userId va xabar kerak." });
  if (!users().some(u => u.id === userId)) return res.status(404).json({ error: "Foydalanuvchi topilmadi." });

  const row = {
    id: id(),
    userId,
    sender: "admin",
    text,
    createdAt: new Date().toISOString()
  };

  const all = messages();
  all.push(row);
  writeJson(FILES.messages, all);

  res.json({ success: true, message: row });
});

// ---------- frontend ----------
app.use(express.static(path.join(ROOT, "public")));

app.use((req, res) => {
  res.sendFile(path.join(ROOT, "public", "index.html"));
});

app.use((err, req, res, next) => {
  console.error("SERVER ERROR:", err);
  if (err instanceof multer.MulterError || err.message?.includes("Faqat")) {
    return res.status(400).json({ error: err.message });
  }
  res.status(500).json({ error: "Server xatosi." });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Qamir AI running on port ${PORT}`);
  console.log(`Gemini: ${process.env.GEMINI_API_KEY ? "configured" : "not configured - fallback mode"}`);
});
