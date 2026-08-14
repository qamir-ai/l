# Qamir AI

Qamir AI — GitHub Pages'da to‘g‘ridan-to‘g‘ri ishlaydigan, Gemini API ixtiyoriy bo‘lgan web AI interfeys.

## Fayllar

- `index.html` — interfeys
- `style.css` — premium dark/purple dizayn
- `app.js` — login, register, profil, chat, agent sozlamalari, knowledge va Gemini
- `config.js` — Gemini API konfiguratsiyasi
- `assets/` — Qamir AI grafiklari

## Ishga tushirish

GitHub repository rootiga fayllarni joylang.

GitHub → Settings → Pages → Deploy from branch → `main` → `/ (root)`.

Backend kerak emas. Sayt static bo‘lib ishlaydi.

## Admin

Birinchi ishga tushganda avtomatik admin yaratiladi:

- Login: `Admin`
- Parol: `Al-qamir`

Agent sozlamalari faqat shu admin hisobida ko‘rinadi.

> Eslatma: GitHub Pages static sayt bo‘lgani uchun bu login haqiqiy server-side xavfsizlik emas. localStorage'dagi ma'lumotlarni foydalanuvchi texnik jihatdan o‘zgartirishi mumkin. Haqiqiy production admin xavfsizligi uchun backend kerak.

## Gemini API

`config.js`:

```js
window.QAMIR_CONFIG = {
  GEMINI_API_KEY: "",
  GEMINI_MODEL: "gemini-2.5-flash"
};
```

Yoki Admin → Agent boshqaruvi → AI / API bo‘limidan key kiriting.

### Juda muhim xavfsizlik

GitHub Pages'dagi API key yashirin emas. `config.js`ga haqiqiy Gemini key yozib public GitHub repositoryga push qilsangiz, keyni istalgan odam ko‘rishi mumkin.

Shuning uchun:
- test uchun vaqtinchalik key ishlating;
- production uchun Gemini API'ni backend/proxy orqali chaqiring;
- GitHub Secret Scanning ogohlantirsa, real keyni revoke/rotate qiling.

## Agent bilimlari

Admin → Agent boshqaruvi bo‘limida:
- Shaxsiyat
- Bilimlar
- Qoidalar
- Javob uslubi
- Takomillashtirish
- AI / API

bo‘limlari mavjud.

Admin qo‘shgan bilimlar Gemini promptiga kontekst sifatida beriladi. Agent matnni nusxalash o‘rniga tabiiy javob tuzadi.

Agent “o‘zini o‘zi o‘zgartirmaydi”: suhbatlarni tahlil qilib, taklif yaratadi. Admin tasdiqlagan taklifgina bilimlar bazasiga qo‘shiladi.

## Fallback

Gemini API bo‘lmasa ham:
- salomlashish;
- admin kiritgan bilimlardan javob;
- foydalanuvchi profili;
- chat tarixi;
- agent sozlamalari

ishlaydi.

## Ma'lumotlar

Ushbu GitHub Pages versiyasi ma'lumotlarni brauzer `localStorage`ida saqlaydi. Brauzer ma'lumotlari o‘chirilsa, ular ham o‘chadi.

Haqiqiy ko‘p foydalanuvchili mahsulot uchun PostgreSQL + backend + server-side authentication tavsiya qilinadi.


## Bilim tuzatish
- `2-BILIM`, `3-BILIM`, `4-BILIM` kabi bir qatorda kelgan bilimlar ham avtomatik alohida ajratiladi.
