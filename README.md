# Qamir AI GitHub Pages

Bu versiya Node.js/Render talab qilmaydi. GitHub Pages'da to‘g‘ridan-to‘g‘ri ochiladi.

Fayllarni repository rootiga joylang va GitHub → Settings → Pages → Deploy from branch → main → root ni tanlang.

## API
`config.js` ichida:
```js
window.QAMIR_CONFIG={
  GEMINI_API_KEY:"",
  GEMINI_MODEL:"gemini-2.5-flash"
};
```
API kerak bo‘lmasa bo‘sh qoldiring.

Muhim: GitHub Pages ochiq frontend bo‘lgani uchun haqiqiy API key `config.js`ga yozilsa, uni boshqalar ko‘rishi mumkin. Test uchun ishlatish mumkin, doimiy foydalanish uchun backend/proxy xavfsizroq.

Ma’lumotlar localStorage’da saqlanadi.
