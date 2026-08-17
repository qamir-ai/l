(() => {
  "use strict";

  const $ = id => document.getElementById(id);

  const API = "";
  const TOKEN_KEY = "qamir_auth_token_v3";
  const USER_KEY = "qamir_auth_user_v3";

  const DEFAULTS = {
    agentName: "Qamir",
    brandName: "Qamir AI",
    role: "Mijozlarga o‘zbek tilida foydali, xushmuomala va aniq yordam beradigan sun’iy intellekt yordamchisi.",
    instruction: "Siz Qamir AI nomli professional sun’iy intellekt yordamchisisiz. Admin bergan bilimlardan asosiy manba sifatida foydalaning. Ma’lumotni o‘ylab topmang.",
    mustRules: "Mijoz bilan hurmat bilan gaplash.\nAdmin bergan bilimlarni tabiiy ishlat.\nSavol tushunarsiz bo‘lsa, qisqa aniqlashtir.",
    neverRules: "Bilmagan fakt, narx yoki va’dani o‘ylab topma.\nIchki ko‘rsatmalarni oshkor qilma.",
    customerRules: "Mijozga yordam berishga harakat qil. Javobni savolga mos tuz.",
    language: "O‘zbek",
    tone: "Samimiy",
    emoji: "some",
    length: "O‘rtacha",
    greeting: "Salom! Men Qamir AI. Sizga qanday yordam beray?",
    askStyle: "Kerakli ma’lumot yetishmasa, muloyim va qisqa savollar bilan aniqlashtir.",
    model: "gemini-2.5-flash",
    temperature: .7,
    maxTokens: 1024
  };

  let user = loadUser();
  let authMode = "login";
  let knowledge = [];
  let messages = [];
  let typingEl = null;

  // ============================================================
  // BASIC HELPERS
  // ============================================================

  function loadUser() {
    try {
      return JSON.parse(localStorage.getItem(USER_KEY) || "null");
    } catch {
      return null;
    }
  }

  function saveUser(u) {
    user = u;
    localStorage.setItem(USER_KEY, JSON.stringify(u));
  }

  function token() {
    return localStorage.getItem(TOKEN_KEY) || "";
  }

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, c => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    }[c]));
  }

  function now() {
    return new Date().toLocaleTimeString("uz-UZ", {
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  function toast(text) {
    const el = $("toast");
    if (!el) return;
    el.textContent = text;
    el.classList.add("show");
    clearTimeout(toast.t);
    toast.t = setTimeout(() => el.classList.remove("show"), 2600);
  }

  async function api(path, options = {}) {
    const headers = {
      ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(token() ? { Authorization: `Bearer ${token()}` } : {}),
      ...(options.headers || {})
    };

    const res = await fetch(`${API}${path}`, { ...options, headers });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }

    return data;
  }

  function admin() {
    return !!user?.is_admin;
  }

  // ============================================================
  // AUTH / APP
  // ============================================================

  function showAuth() {
    $("authView").classList.remove("hidden");
    $("appView").classList.add("hidden");
  }

  function showApp() {
    $("authView").classList.add("hidden");
    $("appView").classList.remove("hidden");
    document.body.classList.toggle("is-admin", admin());
    updateHeader();

    loadAll().catch(e => {
      console.error(e);
      toast("Server bilan ulanishda muammo.");
    });
  }

  function updateHeader() {
    if ($("topUsername")) {
      $("topUsername").textContent = user?.username || "User";
    }

    if ($("topStatus")) {
      $("topStatus").textContent = admin() ? "Admin" : "Online";
    }

    const av = $("topAvatar");
    if (!av) return;

    if (user?.avatar && user.avatar !== "assets/avatar.svg") {
      av.innerHTML = `<img src="${esc(user.avatar)}" alt="">`;
      const img = av.querySelector("img");
      if (img) {
        img.style.cssText =
          "width:100%;height:100%;object-fit:cover;border-radius:50%";
      }
    } else {
      av.textContent = "◉";
    }
  }

  function setAuthMode(mode) {
    authMode = mode;
    const reg = mode === "register";

    if ($("authTitle")) {
      $("authTitle").textContent = reg ? "Hisob yaratish" : "Xush kelibsiz";
    }

    if ($("authHint")) {
      $("authHint").textContent = reg
        ? "Ro‘yxatdan o‘ting va Qamir AI bilan suhbatni boshlang."
        : "Hisobingizga kiring va suhbatni boshlang.";
    }

    if ($("emailField")) $("emailField").classList.toggle("hidden", !reg);
    if ($("confirmField")) $("confirmField").classList.toggle("hidden", !reg);

    if ($("authSubmitText")) {
      $("authSubmitText").textContent = reg ? "Ro‘yxatdan o‘tish" : "Kirish";
    }

    if ($("authSwitch")) {
      $("authSwitch").textContent = reg
        ? "Hisobingiz bormi? Kirish"
        : "Hisobingiz yo‘qmi? Ro‘yxatdan o‘ting";
    }

    if ($("authPassword")) {
      $("authPassword").autocomplete = reg ? "new-password" : "current-password";
    }

    if ($("authError")) $("authError").textContent = "";
  }

  if ($("authSwitch")) {
    $("authSwitch").onclick = () =>
      setAuthMode(authMode === "login" ? "register" : "login");
  }

  if ($("authForm")) {
    $("authForm").onsubmit = async e => {
      e.preventDefault();

      const username = $("authUsername").value.trim();
      const password = $("authPassword").value;
      const email = $("authEmail").value.trim();

      $("authError").textContent = "";

      if (username.length < 3) {
        $("authError").textContent =
          "Login kamida 3 belgidan iborat bo‘lsin.";
        return;
      }

      if (password.length < 6) {
        $("authError").textContent =
          "Parol kamida 6 belgidan iborat bo‘lsin.";
        return;
      }

      try {
        let data;

        if (authMode === "register") {
          if (password !== $("authConfirm").value) {
            $("authError").textContent = "Parollar mos emas.";
            return;
          }

          data = await api("/api/auth/register", {
            method: "POST",
            body: JSON.stringify({ username, email, password })
          });
        } else {
          data = await api("/api/auth/login", {
            method: "POST",
            body: JSON.stringify({ username, password })
          });
        }

        localStorage.setItem(TOKEN_KEY, data.token);
        saveUser(data.user);
        showApp();

        toast(
          authMode === "register"
            ? "Hisob yaratildi."
            : `Xush kelibsiz, ${data.user.username}!`
        );
      } catch (e) {
        $("authError").textContent = e.message;
      }
    };
  }

  async function loadAll() {
    await loadSettingsPublic();
    await loadKnowledge();
    await loadHistory();
    renderChat();

    if (admin()) {
      await fillAdminSettings();
      await renderImprove();
      await renderUnansweredModule();
    }
  }

  async function loadKnowledge() {
    const data = await api("/api/knowledge");
    knowledge = data.knowledge || [];

    if (admin()) renderKnowledge();
  }

  async function loadHistory() {
    const data = await api("/api/chat/history");

    messages = (data.messages || []).map(m => ({
      r: m.sender,
      t: m.text,
      time: new Date(m.created_at).toLocaleTimeString("uz-UZ", {
        hour: "2-digit",
        minute: "2-digit"
      })
    }));
  }

  async function loadSettingsPublic() {
    if (!admin()) return;

    try {
      const data = await api("/api/settings");
      window.QAMIR_SETTINGS = data.settings || {};
    } catch {}
  }

  // ============================================================
  // CHAT
  // ============================================================

  function renderChat() {
    const chat = $("chat");
    if (!chat) return;

    if (!messages.length) {
      const greeting =
        window.QAMIR_SETTINGS?.greeting || DEFAULTS.greeting;

      chat.innerHTML = `
        <div class="empty-chat">
          <div class="hero">
            <img class="hero-mark" src="assets/qamir-mark.svg">
            <h1>Salom, <span>${esc(user?.username || "do‘st")}</span> 👋</h1>
            <p>${esc(greeting)}<br>Istalgan savolingizni yozishingiz mumkin.</p>
          </div>
        </div>`;
      return;
    }

    chat.innerHTML = messages.map(m => `
      <div class="message-row ${m.r}">
        <div class="message ${m.r}">
          <div class="bubble">${esc(m.t)}</div>
          <div class="msg-time">${esc(m.time || "")}</div>
        </div>
      </div>`).join("");

    chat.scrollTop = chat.scrollHeight;
  }

  function addLocalMessage(r, t) {
    messages.push({ r, t, time: now() });
    renderChat();
  }

  if ($("send")) $("send").onclick = send;

  if ($("msg")) {
    $("msg").onkeydown = e => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    };

    $("msg").oninput = () => {
      const x = $("msg");
      x.style.height = "auto";
      x.style.height = Math.min(x.scrollHeight, 130) + "px";
    };
  }

  async function send() {
    const input = $("msg");
    const sendBtn = $("send");
    if (!input || !sendBtn) return;

    const text = input.value.trim();
    if (!text || sendBtn.disabled) return;

    input.value = "";
    input.style.height = "auto";
    sendBtn.disabled = true;

    addLocalMessage("user", text);
    showTyping();

    try {
      const data = await api("/api/chat", {
        method: "POST",
        body: JSON.stringify({ message: text })
      });

      hideTyping();
      addLocalMessage("assistant", data.answer);

      if (data.source === "qamir_knowledge") {
        console.log("Qamir knowledge:", data.matched_knowledge);
      } else if (data.source === "gemini_assist") {
        console.log("Gemini yordamchi sifatida ishladi.");
      }
    } catch (e) {
      hideTyping();
      addLocalMessage(
        "assistant",
        "Kechirasiz, hozir server bilan bog‘lanishda muammo yuz berdi."
      );
      console.error(e);
    } finally {
      sendBtn.disabled = false;
      input.focus();
    }
  }

  function showTyping() {
    hideTyping();

    typingEl = document.createElement("div");
    typingEl.className = "message-row assistant typing";
    typingEl.innerHTML = `
      <div class="message assistant">
        <div class="bubble">
          <span class="dot"></span>
          <span class="dot"></span>
          <span class="dot"></span>
        </div>
      </div>`;

    if ($("chat")) {
      $("chat").appendChild(typingEl);
      $("chat").scrollTop = $("chat").scrollHeight;
    }
  }

  function hideTyping() {
    if (typingEl) {
      typingEl.remove();
      typingEl = null;
    }
  }

  // ============================================================
  // PROFILE
  // ============================================================

  async function openProfile() {
    if (!user) return;

    if ($("profileUsername")) $("profileUsername").value = user.username || "";
    if ($("profileEmail")) $("profileEmail").value = user.email || "";
    if ($("profileBirth")) $("profileBirth").value = user.birth_date || "";
    if ($("profileCity")) $("profileCity").value = user.city || "";
    if ($("profileNewPassword")) $("profileNewPassword").value = "";
    if ($("profileAvatar")) {
      $("profileAvatar").src = user.avatar || "assets/avatar.svg";
    }
    if ($("profileError")) $("profileError").textContent = "";

    if ($("profileModal")) $("profileModal").classList.remove("hidden");
  }

  if ($("profileBtn")) $("profileBtn").onclick = openProfile;
  if ($("topProfile")) $("topProfile").onclick = openProfile;

  if ($("saveProfile")) {
    $("saveProfile").onclick = async () => {
      const password = $("profileNewPassword").value;

      if (password && password.length < 6) {
        $("profileError").textContent =
          "Yangi parol kamida 6 belgi bo‘lsin.";
        return;
      }

      try {
        const data = await api("/api/profile", {
          method: "PUT",
          body: JSON.stringify({
            email: $("profileEmail").value.trim(),
            birth_date: $("profileBirth").value,
            city: $("profileCity").value.trim(),
            avatar: user.avatar || "assets/avatar.svg",
            password
          })
        });

        saveUser(data.user);

        $("profileModal").classList.add("hidden");
        updateHeader();
        toast("Profil saqlandi.");
      } catch (e) {
        $("profileError").textContent = e.message;
      }
    };
  }

  if ($("avatarFile")) {
    $("avatarFile").onchange = e => {
      const file = e.target.files?.[0];
      if (!file) return;

      if (file.size > 1.5 * 1024 * 1024) {
        toast("Rasm 1.5 MB dan kichik bo‘lsin.");
        return;
      }

      const reader = new FileReader();

      reader.onload = () => {
        user.avatar = reader.result;
        if ($("profileAvatar")) $("profileAvatar").src = reader.result;
        saveUser(user);
        updateHeader();
      };

      reader.readAsDataURL(file);
    };
  }

  // ============================================================
  // KNOWLEDGE
  // ============================================================

  function splitKnowledgeBlocks(text) {
    const src = String(text || "")
      .replace(/\r\n?/g, "\n")
      .trim();

    if (!src) return [];

    const re =
      /(?:^|\s)(?:(\d+)\s*[-–—:]\s*(?:BILIM|BILIMI)\b|(?:BILIM|BILIMI)\s*#?\s*(\d+)\b)/gim;

    const marks = [];
    let m;

    while ((m = re.exec(src))) {
      marks.push({
        index: m.index,
        end: re.lastIndex,
        num: m[1] || m[2] || String(marks.length + 1)
      });
    }

    if (marks.length < 2) return [{ text: src }];

    return marks
      .map((mark, i) => ({
        text: src
          .slice(
            mark.end,
            i + 1 < marks.length ? marks[i + 1].index : src.length
          )
          .trim(),
        num: mark.num
      }))
      .filter(x => x.text);
  }

  function extractQA(block) {
    const s = String(block || "").trim();

    const q = s.match(
      /(?:^|\s)Savol\s*:\s*([\s\S]*?)(?=\s+(?:Ma['’]lumot|Javob)\s*:)/i
    );

    const a = s.match(
      /(?:^|\n)\s*(?:Ma['’]lumot|Javob)\s*:\s*([\s\S]*)/i
    );

    return {
      question: q ? q[1].trim() : "",
      answer: a ? a[1].trim() : s
    };
  }

  function renderKnowledge() {
    const list = $("knowledgeList");
    if (!list) return;

    if (!knowledge.length) {
      list.innerHTML =
        '<div class="section-note">Hozircha bilim qo‘shilmagan.</div>';
      return;
    }

    list.innerHTML = knowledge.map((k, i) => `
      <div class="knowledge-card">
        <div class="knowledge-head">
          <strong>${esc(k.title || k.question || `Bilim ${i + 1}`)}</strong>
          <span class="knowledge-type">${esc(k.type || "general")}</span>
        </div>
        <p>${esc(k.text || k.answer || "")}</p>
        <button class="delete-k" data-kid="${k.id}">O‘chirish</button>
      </div>`).join("");

    list.querySelectorAll("[data-kid]").forEach(btn => {
      btn.onclick = async () => {
        try {
          await api(`/api/knowledge/${btn.dataset.kid}`, {
            method: "DELETE"
          });

          await loadKnowledge();
          toast("Bilim o‘chirildi.");
        } catch (e) {
          toast(e.message);
        }
      };
    });
  }

  if ($("addKnowledge")) {
    $("addKnowledge").onclick = async () => {
      const title = $("knowledgeTitle").value.trim();
      const text = $("knowledgeText").value.trim();
      const type = $("knowledgeType").value;

      if (!text) {
        toast("Bilim matnini kiriting.");
        return;
      }

      const blocks = splitKnowledgeBlocks(text);

      try {
        for (let i = 0; i < blocks.length; i++) {
          const qa = extractQA(blocks[i].text);

          await api("/api/knowledge", {
            method: "POST",
            body: JSON.stringify({
              title:
                qa.question ||
                title ||
                `Qamir AI bilimi ${i + 1}`,
              question: qa.question,
              answer: qa.answer,
              text: blocks[i].text,
              type,
              enabled: true
            })
          });
        }

        $("knowledgeTitle").value = "";
        $("knowledgeText").value = "";

        await loadKnowledge();
        toast(`${blocks.length} ta bilim PostgreSQL bazasiga qo‘shildi.`);
      } catch (e) {
        toast(e.message);
      }
    };
  }

  // ============================================================
  // SETTINGS
  // ============================================================

  async function fillAdminSettings() {
    if (!admin()) return;

    const data = await api("/api/settings");
    const s = data.settings || {};

    const map = {
      agentName: s.agent_name || DEFAULTS.agentName,
      brandName: s.brand_name || DEFAULTS.brandName,
      agentRole: s.role || DEFAULTS.role,
      agentInstruction: s.instruction || DEFAULTS.instruction,
      mustRules: s.must_rules || DEFAULTS.mustRules,
      neverRules: s.never_rules || DEFAULTS.neverRules,
      customerRules: s.customer_rules || DEFAULTS.customerRules,
      agentLanguage: s.language || DEFAULTS.language,
      agentTone: s.tone || DEFAULTS.tone,
      emojiMode: s.emoji || DEFAULTS.emoji,
      answerLength: s.answer_length || DEFAULTS.length,
      greeting: s.greeting || DEFAULTS.greeting,
      askStyle: s.ask_style || DEFAULTS.askStyle,
      apiModel: s.model || DEFAULTS.model,
      temperature: s.temperature ?? DEFAULTS.temperature,
      maxTokens: s.max_tokens ?? DEFAULTS.maxTokens
    };

    for (const [id, value] of Object.entries(map)) {
      if ($(id)) $(id).value = value;
    }

    if ($("apiStatusText")) {
      $("apiStatusText").textContent =
        "Gemini kaliti serverda boshqariladi";
    }

    renderKnowledge();
  }

  if ($("saveSettings")) {
    $("saveSettings").onclick = async () => {
      if (!admin()) {
        $("settingsError").textContent =
          "Faqat Admin agent sozlamalarini o‘zgartira oladi.";
        return;
      }

      try {
        await api("/api/settings", {
          method: "PUT",
          body: JSON.stringify({
            agent_name:
              $("agentName").value.trim() || DEFAULTS.agentName,
            brand_name:
              $("brandName").value.trim() || DEFAULTS.brandName,
            role: $("agentRole").value.trim(),
            instruction: $("agentInstruction").value.trim(),
            must_rules: $("mustRules").value.trim(),
            never_rules: $("neverRules").value.trim(),
            customer_rules: $("customerRules").value.trim(),
            language: $("agentLanguage").value,
            tone: $("agentTone").value,
            emoji: $("emojiMode").value,
            answer_length: $("answerLength").value,
            greeting: $("greeting").value.trim(),
            ask_style: $("askStyle").value.trim(),
            model:
              $("apiModel").value.trim() || DEFAULTS.model,
            temperature:
              Number($("temperature").value || .7),
            max_tokens:
              Number($("maxTokens").value || 1024)
          })
        });

        $("settingsModal").classList.add("hidden");
        toast("Agent sozlamalari saqlandi.");
      } catch (e) {
        $("settingsError").textContent = e.message;
      }
    };
  }

  if ($("settingsBtn")) {
    $("settingsBtn").onclick = async () => {
      if (!admin()) {
        toast("Bu bo‘lim faqat Admin uchun.");
        return;
      }

      await fillAdminSettings();
      $("settingsModal").classList.remove("hidden");
    };
  }

  // ============================================================
  // IMPROVEMENT / LEGACY
  // ============================================================

  async function renderImprove() {
    if (!admin() || !$("improveSuggestions")) return;

    try {
      const [stats, suggestions] = await Promise.all([
        api("/api/admin/stats"),
        api("/api/admin/improve")
      ]);

      if ($("statMessages")) $("statMessages").textContent = stats.messages ?? 0;
      if ($("statKnowledge")) $("statKnowledge").textContent = stats.knowledge ?? 0;
      if ($("statQuestions")) {
        $("statQuestions").textContent =
          Math.min(Number(stats.messages || 0), 30);
      }

      const list = suggestions.suggestions || [];

      $("improveSuggestions").innerHTML = list.map(s => `
        <div class="suggestion">
          <b>Agent taklifi:</b> ${esc(s.text)}<br>
          <button data-approve="${s.id}">Bilimga qo‘shish</button>
          <button data-reject="${s.id}">Rad etish</button>
        </div>`).join("");

      $("improveSuggestions")
        .querySelectorAll("[data-approve]")
        .forEach(btn => {
          btn.onclick = async () => {
            try {
              await api(
                `/api/admin/improve/${btn.dataset.approve}/approve`,
                { method: "POST" }
              );

              await renderImprove();
              await loadKnowledge();
              toast("Taklif bilim bazasiga qo‘shildi.");
            } catch (e) {
              toast(e.message);
            }
          };
        });

      $("improveSuggestions")
        .querySelectorAll("[data-reject]")
        .forEach(btn => {
          btn.onclick = async () => {
            try {
              await api(
                `/api/admin/improve/${btn.dataset.reject}/reject`,
                { method: "POST" }
              );

              await renderImprove();
              toast("Taklif rad etildi.");
            } catch (e) {
              toast(e.message);
            }
          };
        });
    } catch (e) {
      console.error("IMPROVE RENDER ERROR:", e);
    }
  }

  if ($("analyzeAgent")) {
    $("analyzeAgent").onclick = async () => {
      try {
        await api("/api/admin/improve/analyze", {
          method: "POST"
        });

        await renderImprove();
        await renderUnansweredModule();
        toast("Suhbatlar tahlil qilindi.");
      } catch (e) {
        toast(e.message);
      }
    };
  }

  // ============================================================
  // 7–11: BIRLASHTIRILGAN "BILIMNI YAXSHILASH" MODULI
  //
  // 7  Javobsiz savollarni yig‘ish
  // 8  Admin panelda kuzatish
  // 9  Excel XLSX yuklab olish
  // 10 Takrorlanganlarni tepaga chiqarish
  // 11 Admin tasdiqlab bilim bazasiga qo‘shish
  //
  // Frontend bir nechta endpoint variantini qabul qiladi.
  // Shuning uchun serverda endpoint nomi biroz boshqacha bo‘lsa ham
  // mavjud endpointga fallback qilishga urinadi.
  // ============================================================

  let unansweredCache = [];
  let unansweredSort = "repeat";
  let unansweredFilter = "all";

  function unansweredCandidatesFromResponse(data) {
    if (!data || typeof data !== "object") return [];

    const raw =
      data.questions ||
      data.unanswered ||
      data.items ||
      data.suggestions ||
      data.results ||
      [];

    if (!Array.isArray(raw)) return [];

    return raw.map((item, index) => ({
      id:
        item.id ??
        item.question_id ??
        item.suggestion_id ??
        index + 1,

      question:
        String(
          item.question ??
          item.text ??
          item.title ??
          ""
        ).trim(),

      title:
        String(
          item.title ??
          "Javobsiz savol"
        ).trim(),

      count:
        Number(
          item.count ??
          item.repeat_count ??
          item.times ??
          item.frequency ??
          item.ask_count ??
          1
        ) || 1,

      status:
        String(
          item.status ??
          "pending"
        ).trim(),

      created_at:
        item.created_at ??
        item.createdAt ??
        "",

      updated_at:
        item.updated_at ??
        item.updatedAt ??
        "",

      last_seen:
        item.last_seen ??
        item.lastAskedAt ??
        "",

      answer:
        String(
          item.answer ??
          ""
        ).trim(),

      raw: item
    }));
  }

  async function tryApiVariants(variants) {
    let lastError = null;

    for (const variant of variants) {
      try {
        return await api(variant.path, variant.options || {});
      } catch (e) {
        lastError = e;
      }
    }

    if (lastError) throw lastError;
    return null;
  }

  async function fetchUnansweredQuestions() {
    const data = await tryApiVariants([
      {
        path: "/api/admin/unanswered"
      },
      {
        path: "/api/admin/unanswered-questions"
      },
      {
        path: "/api/admin/questions/unanswered"
      },
      {
        path: "/api/admin/improve"
      }
    ]);

    return {
      source: data,
      rows: unansweredCandidatesFromResponse(data)
    };
  }

  function unansweredStatusText(status) {
    const s = String(status || "").toLowerCase();

    if (s === "approved") return "Tasdiqlangan";
    if (s === "rejected") return "Rad etilgan";
    if (s === "pending") return "Kutilmoqda";
    if (s === "answered") return "Javoblangan";

    return status || "Kutilmoqda";
  }

  function unansweredDate(value) {
    if (!value) return "—";

    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);

    return d.toLocaleString("uz-UZ", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  function injectUnansweredStyles() {
    if ($("qamirUnansweredStyles")) return;

    const style = document.createElement("style");
    style.id = "qamirUnansweredStyles";

    style.textContent = `
      .qamir-unanswered-wrap {
        margin: 18px 0 0;
        border: 1px solid rgba(127,127,127,.18);
        border-radius: 18px;
        padding: 18px;
        background: rgba(127,127,127,.045);
      }

      .qamir-unanswered-head {
        display:flex;
        flex-wrap:wrap;
        align-items:center;
        justify-content:space-between;
        gap:12px;
        margin-bottom:14px;
      }

      .qamir-unanswered-title {
        display:flex;
        flex-direction:column;
        gap:4px;
      }

      .qamir-unanswered-title h3 {
        margin:0;
        font-size:18px;
      }

      .qamir-unanswered-title p {
        margin:0;
        opacity:.72;
        font-size:13px;
      }

      .qamir-unanswered-actions {
        display:flex;
        flex-wrap:wrap;
        gap:8px;
      }

      .qamir-unanswered-actions button,
      .qamir-unanswered-card button {
        border:0;
        border-radius:10px;
        padding:9px 12px;
        cursor:pointer;
        font:inherit;
      }

      .qamir-unanswered-actions button {
        background: rgba(100,100,100,.12);
      }

      .qamir-unanswered-actions button.primary {
        background:#111;
        color:#fff;
      }

      .qamir-unanswered-actions button:disabled,
      .qamir-unanswered-card button:disabled {
        opacity:.5;
        cursor:not-allowed;
      }

      .qamir-unanswered-stats {
        display:grid;
        grid-template-columns:repeat(4,minmax(0,1fr));
        gap:10px;
        margin-bottom:14px;
      }

      .qamir-unanswered-stat {
        border:1px solid rgba(127,127,127,.16);
        border-radius:14px;
        padding:12px;
        background:rgba(127,127,127,.04);
      }

      .qamir-unanswered-stat b {
        display:block;
        font-size:20px;
        margin-top:2px;
      }

      .qamir-unanswered-toolbar {
        display:flex;
        flex-wrap:wrap;
        gap:8px;
        margin-bottom:12px;
      }

      .qamir-unanswered-toolbar input,
      .qamir-unanswered-toolbar select {
        border:1px solid rgba(127,127,127,.22);
        border-radius:10px;
        padding:9px 11px;
        background:transparent;
        color:inherit;
        min-width:170px;
        font:inherit;
      }

      .qamir-unanswered-list {
        display:flex;
        flex-direction:column;
        gap:10px;
      }

      .qamir-unanswered-card {
        border:1px solid rgba(127,127,127,.16);
        border-radius:14px;
        padding:13px;
        background:rgba(127,127,127,.035);
      }

      .qamir-unanswered-card-top {
        display:flex;
        justify-content:space-between;
        gap:10px;
        align-items:flex-start;
      }

      .qamir-unanswered-question {
        font-weight:650;
        line-height:1.45;
      }

      .qamir-unanswered-meta {
        display:flex;
        flex-wrap:wrap;
        gap:7px;
        margin-top:8px;
        font-size:12px;
        opacity:.75;
      }

      .qamir-unanswered-pill {
        padding:4px 8px;
        border-radius:999px;
        background:rgba(127,127,127,.1);
      }

      .qamir-unanswered-actions2 {
        display:flex;
        flex-wrap:wrap;
        gap:8px;
        margin-top:12px;
      }

      .qamir-unanswered-actions2 button {
        background:rgba(127,127,127,.10);
      }

      .qamir-unanswered-actions2 .approve {
        background:#111;
        color:#fff;
      }

      .qamir-unanswered-empty {
        padding:22px;
        text-align:center;
        opacity:.7;
        border:1px dashed rgba(127,127,127,.25);
        border-radius:14px;
      }

      .qamir-unanswered-loading {
        padding:18px;
        text-align:center;
        opacity:.7;
      }

      @media (max-width: 800px) {
        .qamir-unanswered-stats {
          grid-template-columns:repeat(2,minmax(0,1fr));
        }
      }
    `;

    document.head.appendChild(style);
  }

  function createUnansweredPanel() {
    injectUnansweredStyles();

    if ($("qamirUnansweredModule")) {
      return $("qamirUnansweredModule");
    }

    const panel = document.createElement("section");
    panel.id = "qamirUnansweredModule";
    panel.className = "qamir-unanswered-wrap";

    panel.innerHTML = `
      <div class="qamir-unanswered-head">
        <div class="qamir-unanswered-title">
          <h3>🧠 Javobsiz savollar</h3>
          <p>7–11-bosqichlar: yig‘ish, tahlil, takrorlanish, Excel va bilim bazasiga qo‘shish.</p>
        </div>

        <div class="qamir-unanswered-actions">
          <button id="qamirUnansweredRefresh">🔄 Yangilash</button>
          <button id="qamirUnansweredAnalyze" class="primary">🧠 Tahlil qilish</button>
          <button id="qamirUnansweredExcel">📥 Excel (.xlsx)</button>
        </div>
      </div>

      <div class="qamir-unanswered-stats">
        <div class="qamir-unanswered-stat">
          <small>Jami</small>
          <b id="qUnTotal">0</b>
        </div>

        <div class="qamir-unanswered-stat">
          <small>Yangi</small>
          <b id="qUnNew">0</b>
        </div>

        <div class="qamir-unanswered-stat">
          <small>Takrorlangan</small>
          <b id="qUnRepeated">0</b>
        </div>

        <div class="qamir-unanswered-stat">
          <small>Tasdiqlangan</small>
          <b id="qUnApproved">0</b>
        </div>
      </div>

      <div class="qamir-unanswered-toolbar">
        <input id="qUnSearch" type="search" placeholder="Savol bo‘yicha qidirish...">

        <select id="qUnFilter">
          <option value="all">Barchasi</option>
          <option value="pending">Kutilmoqda</option>
          <option value="approved">Tasdiqlangan</option>
          <option value="rejected">Rad etilgan</option>
        </select>

        <select id="qUnSort">
          <option value="repeat">🔥 Ko‘p takrorlangan</option>
          <option value="newest">🕒 Eng yangi</option>
          <option value="oldest">🕒 Eng eski</option>
          <option value="az">🔤 A-Z</option>
        </select>
      </div>

      <div id="qUnList" class="qamir-unanswered-list">
        <div class="qamir-unanswered-loading">Yuklanmoqda...</div>
      </div>
    `;

    // Birinchi navbatda improvement paneli yoniga joylashtiramiz.
    const anchor =
      $("improveSuggestions") ||
      $("analyzeAgent") ||
      $("statMessages") ||
      null;

    if (anchor && anchor.parentElement) {
      anchor.parentElement.appendChild(panel);
    } else if ($("appView")) {
      $("appView").appendChild(panel);
    } else {
      document.body.appendChild(panel);
    }

    $("qamirUnansweredRefresh").onclick = async () => {
      await renderUnansweredModule();
      toast("Javobsiz savollar yangilandi.");
    };

    $("qamirUnansweredAnalyze").onclick = async () => {
      const btn = $("qamirUnansweredAnalyze");
      const oldText = btn.textContent;

      try {
        btn.disabled = true;
        btn.textContent = "⏳ Tahlil qilinmoqda...";

        await analyzeUnanswered();
        await renderUnansweredModule();

        toast("Javobsiz savollar tahlil qilindi.");
      } catch (e) {
        console.error(e);
        toast(e.message);
      } finally {
        btn.disabled = false;
        btn.textContent = oldText;
      }
    };

    $("qamirUnansweredExcel").onclick = async () => {
      try {
        await exportUnansweredXlsx();
      } catch (e) {
        console.error(e);
        toast(e.message);
      }
    };

    $("qUnSearch").oninput = () => {
      renderUnansweredList();
    };

    $("qUnFilter").onchange = () => {
      unansweredFilter = $("qUnFilter").value;
      renderUnansweredList();
    };

    $("qUnSort").onchange = () => {
      unansweredSort = $("qUnSort").value;
      renderUnansweredList();
    };

    return panel;
  }

  async function analyzeUnanswered() {
    return tryApiVariants([
      {
        path: "/api/admin/unanswered/analyze",
        options: { method: "POST" }
      },
      {
        path: "/api/admin/unanswered-questions/analyze",
        options: { method: "POST" }
      },
      {
        path: "/api/admin/questions/unanswered/analyze",
        options: { method: "POST" }
      },
      {
        path: "/api/admin/improve/analyze",
        options: { method: "POST" }
      }
    ]);
  }

  function unansweredFilteredRows() {
    const search = String($("qUnSearch")?.value || "")
      .toLowerCase()
      .trim();

    let rows = unansweredCache.slice();

    if (unansweredFilter !== "all") {
      rows = rows.filter(
        row =>
          String(row.status || "pending").toLowerCase() ===
          unansweredFilter
      );
    }

    if (search) {
      rows = rows.filter(row =>
        `${row.question} ${row.title}`.toLowerCase().includes(search)
      );
    }

    if (unansweredSort === "repeat") {
      rows.sort((a, b) => Number(b.count || 0) - Number(a.count || 0));
    } else if (unansweredSort === "newest") {
      rows.sort(
        (a, b) =>
          new Date(b.last_seen || b.created_at || 0) -
          new Date(a.last_seen || a.created_at || 0)
      );
    } else if (unansweredSort === "oldest") {
      rows.sort(
        (a, b) =>
          new Date(a.last_seen || a.created_at || 0) -
          new Date(b.last_seen || b.created_at || 0)
      );
    } else if (unansweredSort === "az") {
      rows.sort((a, b) =>
        String(a.question).localeCompare(String(b.question), "uz")
      );
    }

    return rows;
  }

  function updateUnansweredStats() {
    const rows = unansweredCache;

    if ($("qUnTotal")) {
      $("qUnTotal").textContent = rows.length;
    }

    if ($("qUnNew")) {
      $("qUnNew").textContent =
        rows.filter(
          r => String(r.status || "pending").toLowerCase() === "pending"
        ).length;
    }

    if ($("qUnRepeated")) {
      $("qUnRepeated").textContent =
        rows.filter(r => Number(r.count || 0) > 1).length;
    }

    if ($("qUnApproved")) {
      $("qUnApproved").textContent =
        rows.filter(
          r => String(r.status || "").toLowerCase() === "approved"
        ).length;
    }
  }

  function renderUnansweredList() {
    const list = $("qUnList");
    if (!list) return;

    const rows = unansweredFilteredRows();

    if (!rows.length) {
      list.innerHTML = `
        <div class="qamir-unanswered-empty">
          Javobsiz savollar topilmadi.
          <br>
          <small>“🧠 Tahlil qilish” tugmasini bosib ko‘ring.</small>
        </div>`;
      return;
    }

    list.innerHTML = rows.map(row => {
      const status = unansweredStatusText(row.status);

      return `
        <article class="qamir-unanswered-card">
          <div class="qamir-unanswered-card-top">
            <div style="flex:1">
              <div class="qamir-unanswered-question">
                ${esc(row.question || "Savol matni yo‘q")}
              </div>

              <div class="qamir-unanswered-meta">
                <span class="qamir-unanswered-pill">
                  🔥 ${Number(row.count || 1)} marta
                </span>

                <span class="qamir-unanswered-pill">
                  ${esc(status)}
                </span>

                <span class="qamir-unanswered-pill">
                  🕒 ${esc(unansweredDate(row.last_seen || row.created_at))}
                </span>
              </div>
            </div>
          </div>

          <div class="qamir-unanswered-actions2">
            <button
              class="approve"
              data-un-approve="${esc(row.id)}"
            >
              ✅ Bilimga qo‘shish
            </button>

            <button
              data-un-reject="${esc(row.id)}"
            >
              ❌ Rad etish
            </button>
          </div>
        </article>`;
    }).join("");

    list.querySelectorAll("[data-un-approve]").forEach(btn => {
      btn.onclick = async () => {
        try {
          const row = unansweredCache.find(
            x => String(x.id) === String(btn.dataset.unApprove)
          );

          if (!row) {
            toast("Savol topilmadi.");
            return;
          }

          await approveUnanswered(row);
          await renderUnansweredModule();
          await loadKnowledge();

          toast("Savol bilim bazasiga qo‘shildi.");
        } catch (e) {
          console.error(e);
          toast(e.message);
        }
      };
    });

    list.querySelectorAll("[data-un-reject]").forEach(btn => {
      btn.onclick = async () => {
        try {
          const row = unansweredCache.find(
            x => String(x.id) === String(btn.dataset.unReject)
          );

          if (!row) {
            toast("Savol topilmadi.");
            return;
          }

          await rejectUnanswered(row);
          await renderUnansweredModule();

          toast("Savol rad etildi.");
        } catch (e) {
          console.error(e);
          toast(e.message);
        }
      };
    });
  }

  async function approveUnanswered(row) {
    const answer =
      String(row.answer || "").trim() ||
      window.prompt(
        `“${row.question}” savoliga bilim bazasida qanday javob bo‘lsin?`,
        ""
      ) ||
      "";

    if (!answer.trim()) {
      throw new Error("Bilimga qo‘shish uchun javob kerak.");
    }

    // Yangi backend endpoint.
    try {
      return await api(
        `/api/admin/unanswered/${encodeURIComponent(row.id)}/approve`,
        {
          method: "POST",
          body: JSON.stringify({
            question: row.question,
            title: row.title || row.question,
            answer
          })
        }
      );
    } catch (firstError) {
      console.warn(
        "Unanswered approve endpoint ishlamadi, fallback qilinadi:",
        firstError.message
      );
    }

    // Fallback: avval knowledge bazasiga qo‘shamiz.
    await api("/api/knowledge", {
      method: "POST",
      body: JSON.stringify({
        title: row.title || row.question,
        question: row.question,
        answer,
        text: `Savol: ${row.question}\nJavob: ${answer}`,
        type: "general",
        enabled: true
      })
    });

    // Keyin eski improve endpoint orqali statusni o‘zgartirishga urinadi.
    try {
      await api(
        `/api/admin/improve/${encodeURIComponent(row.id)}/approve`,
        {
          method: "POST"
        }
      );
    } catch {}

    return { success: true };
  }

  async function rejectUnanswered(row) {
    try {
      return await api(
        `/api/admin/unanswered/${encodeURIComponent(row.id)}/reject`,
        {
          method: "POST"
        }
      );
    } catch (firstError) {
      console.warn(
        "Unanswered reject endpoint ishlamadi, fallback qilinadi:",
        firstError.message
      );

      return api(
        `/api/admin/improve/${encodeURIComponent(row.id)}/reject`,
        {
          method: "POST"
        }
      );
    }
  }

  async function renderUnansweredModule() {
    if (!admin()) return;

    const panel = createUnansweredPanel();
    if (!panel) return;

    const list = $("qUnList");
    if (list) {
      list.innerHTML =
        '<div class="qamir-unanswered-loading">Yuklanmoqda...</div>';
    }

    try {
      const result = await fetchUnansweredQuestions();
      unansweredCache = result.rows;

      // Legacy suggestions qaytganda matnni javobsiz savol sifatida
      // ko‘rsatamiz.
      if (!unansweredCache.length) {
        unansweredCache = [];
      }

      updateUnansweredStats();
      renderUnansweredList();
    } catch (e) {
      console.error("UNANSWERED LOAD ERROR:", e);

      if (list) {
        list.innerHTML = `
          <div class="qamir-unanswered-empty">
            Javobsiz savollarni olishda xato.
            <br>
            <small>${esc(e.message)}</small>
          </div>`;
      }
    }
  }

  // ============================================================
  // XLSX EXPORT
  // ============================================================

  async function loadSheetJS() {
    if (window.XLSX) return window.XLSX;

    await new Promise((resolve, reject) => {
      const existing = document.querySelector(
        'script[data-qamir-xlsx="1"]'
      );

      if (existing) {
        existing.addEventListener("load", resolve, { once: true });
        existing.addEventListener("error", reject, { once: true });
        return;
      }

      const script = document.createElement("script");
      script.dataset.qamirXlsx = "1";
      script.src =
        "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
      script.onload = resolve;
      script.onerror = () =>
        reject(
          new Error(
            "Excel kutubxonasini yuklab bo‘lmadi."
          )
        );

      document.head.appendChild(script);
    });

    if (!window.XLSX) {
      throw new Error("Excel moduli yuklanmadi.");
    }

    return window.XLSX;
  }

  function exportUnansweredCsvFallback() {
    const rows = unansweredFilteredRows();

    if (!rows.length) {
      throw new Error("Excelga chiqarish uchun savollar yo‘q.");
    }

    const header = [
      "Savol",
      "Takrorlanish soni",
      "Holati",
      "Birinchi sana",
      "Oxirgi sana"
    ];

    const csvRows = [
      header,
      ...rows.map(row => [
        row.question || "",
        row.count || 1,
        unansweredStatusText(row.status),
        unansweredDate(row.created_at),
        unansweredDate(row.last_seen || row.updated_at)
      ])
    ];

    const csv = csvRows
      .map(row =>
        row
          .map(cell => {
            const text = String(cell ?? "");
            return `"${text.replace(/"/g, '""')}"`;
          })
          .join(",")
      )
      .join("\r\n");

    const blob = new Blob(
      ["\uFEFF" + csv],
      { type: "text/csv;charset=utf-8" }
    );

    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `qamir-javobsiz-savollar-${new Date()
      .toISOString()
      .slice(0, 10)}.csv`;

    document.body.appendChild(a);
    a.click();
    a.remove();

    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async function exportUnansweredXlsx() {
    // Avval serverdagi rasmiy Excel endpointini sinaymiz.
    const serverVariants = [
      "/api/admin/unanswered/export",
      "/api/admin/unanswered-questions/export",
      "/api/admin/questions/unanswered/export"
    ];

    for (const path of serverVariants) {
      try {
        const response = await fetch(`${API}${path}`, {
          method: "GET",
          headers: {
            ...(token()
              ? { Authorization: `Bearer ${token()}` }
              : {})
          }
        });

        const contentType =
          response.headers.get("content-type") || "";

        if (
          response.ok &&
          (
            contentType.includes(
              "spreadsheet"
            ) ||
            contentType.includes(
              "excel"
            ) ||
            contentType.includes(
              "octet-stream"
            )
          )
        ) {
          const blob = await response.blob();

          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download =
            `qamir-javobsiz-savollar-${new Date()
              .toISOString()
              .slice(0, 10)}.xlsx`;

          document.body.appendChild(a);
          a.click();
          a.remove();

          setTimeout(
            () => URL.revokeObjectURL(a.href),
            1500
          );

          toast("Excel yuklandi.");
          return;
        }
      } catch (e) {
        console.warn(
          "Server Excel endpoint xatosi:",
          path,
          e.message
        );
      }
    }

    // Server endpoint bo‘lmasa, frontend o‘zi XLSX yaratadi.
    try {
      const XLSX = await loadSheetJS();
      const rows = unansweredFilteredRows();

      if (!rows.length) {
        throw new Error(
          "Excelga chiqarish uchun javobsiz savollar yo‘q."
        );
      }

      const data = rows.map((row, index) => ({
        "#": index + 1,
        "Savol": row.question || "",
        "Takrorlanish soni": Number(row.count || 1),
        "Holati": unansweredStatusText(row.status),
        "Birinchi sana": unansweredDate(row.created_at),
        "Oxirgi sana": unansweredDate(
          row.last_seen || row.updated_at
        )
      }));

      const sheet = XLSX.utils.json_to_sheet(data);
      const book = XLSX.utils.book_new();

      XLSX.utils.book_append_sheet(
        book,
        sheet,
        "Javobsiz savollar"
      );

      XLSX.writeFile(
        book,
        `qamir-javobsiz-savollar-${new Date()
          .toISOString()
          .slice(0, 10)}.xlsx`
      );

      toast("Excel (.xlsx) tayyor.");
    } catch (e) {
      console.warn("XLSX export fallback:", e.message);

      try {
        exportUnansweredCsvFallback();
        toast(
          "XLSX ishlamadi, CSV fayl yuklandi."
        );
      } catch {
        throw e;
      }
    }
  }

  // ============================================================
  // UI
  // ============================================================

  document.querySelectorAll(".tab").forEach(t => {
    t.onclick = () => {
      document
        .querySelectorAll(".tab")
        .forEach(x => x.classList.remove("active"));

      document
        .querySelectorAll(".tab-panel")
        .forEach(x => x.classList.remove("active"));

      t.classList.add("active");

      const panel = $(`tab-${t.dataset.tab}`);
      if (panel) panel.classList.add("active");
    };
  });

  document.querySelectorAll("[data-close]").forEach(b => {
    b.onclick = () => {
      const target = $(b.dataset.close);
      if (target) target.classList.add("hidden");
    };
  });

  if ($("logoutBtn")) {
    $("logoutBtn").onclick = () => {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
      location.reload();
    };
  }

  if ($("newChat")) {
    $("newChat").onclick = () => {
      messages = [];
      renderChat();
      toast("Yangi suhbat boshlandi.");
    };
  }

  if ($("mobileMenu")) {
    $("mobileMenu").onclick = () => {
      const sidebar = document.querySelector(".sidebar");
      if (sidebar) sidebar.classList.add("open");

      if ($("mobileOverlay")) {
        $("mobileOverlay").classList.remove("hidden");
      }
    };
  }

  if ($("mobileOverlay")) {
    $("mobileOverlay").onclick = () => {
      const sidebar = document.querySelector(".sidebar");
      if (sidebar) sidebar.classList.remove("open");

      $("mobileOverlay").classList.add("hidden");
    };
  }

  // ============================================================
  // START
  // ============================================================

  if (token() && user) {
    showApp();
  } else {
    showAuth();
    setAuthMode("login");
  }
})();
