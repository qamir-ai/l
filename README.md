# Qamir AI

Standalone Node.js web AI. GitHub'ga yuklab, Node.js qo'llab-quvvatlaydigan istalgan serverda ishga tushirish mumkin.

## Ishga tushirish

```bash
npm install
npm start
```

Sayt:
`http://localhost:10000`

## Admin

Admin login:
- Login: `Admin`
- Parol: `Al-qamir`

Admin parolini sayt ichidan o'zgartirish funksiyasi ataylab yo'q.

## Gemini

Gemini API majburiy emas.

Keyin `.env` fayliga:

```env
GEMINI_API_KEY=YOUR_KEY
GEMINI_MODEL=gemini-2.5-flash
PORT=10000
```

API key bo'lmasa ham sayt ishlaydi: Qamir o'zining admin sozlamasidagi bilim/instructions va built-in fallback javoblari bilan ishlaydi. Gemini key qo'yilganda esa chat Gemini orqali javob beradi.

## Muhim

`data/` papkasi foydalanuvchilar, xabarlar va rasmlarni saqlaydi. Serveringiz diskni qayta o'rnatganda/ephemeral bo'lsa, bu ma'lumotlar yo'qolishi mumkin. Doimiy diskli hosting ishlating.
