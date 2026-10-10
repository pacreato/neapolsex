# Neapol Lake — ВАРІАНТ для Vercel

## Чому пароль адміна і оплата не працювали
Серверна частина сайту (бронювання, оплата Monobank, пароль адміна) — це адреса `/api/...`. У попередніх архівах вона написана для **Netlify** (NETLIFY) і для **власного сервера** (NODE). На Vercel вони не запускаються, тому `/api` там дає 404, а сайт у відповідь пише «Невірний пароль». Змінні тут ні при чому.
Перевірка: відкрийте `https://ваш-сайт.vercel.app/api/health`. Якщо 404 — на Vercel лежить стара версія. Цей архів — серверна частина саме для Vercel.

## Що в архіві
```
vercel.json          публікація з папки public
package.json
api/[...path].js     уся серверна частина (Vercel Function)
public/              сайт: index.html, images/, manifest, sw.js
```
Дані (броні, новини, ціни, фото) зберігаються в **Upstash Redis** (підключається в Vercel за кілька кліків).

## Кроки
1. **Файли в GitHub.** У репозиторії, який підключений до Vercel, завантажте **папки `api` і `public`** та файли `vercel.json`, `package.json` (перетягніть саме папки, щоб лишилась структура). Файл усередині `api` має називатись `[...path].js` (з квадратними дужками і трьома крапками). Старі файли (папка `netlify`, `netlify.toml`) можна видалити.
   Якщо GitHub «розсипає» папки — використайте Vercel CLI: у папці з розпакованим архівом виконайте `npm install -g vercel`, `vercel login`, `vercel --prod`.
2. **Проєкт у Vercel.** Add New → Project → оберіть репозиторій. Framework Preset: **Other**. Решту не чіпайте (налаштування беруться з vercel.json).
3. **База даних.** У проєкті відкрийте вкладку **Storage** (або Integrations/Marketplace) → **Upstash Redis** → створіть базу (регіон Frankfurt) → **Connect to Project**. Vercel сам додасть змінні `KV_REST_API_URL` і `KV_REST_API_TOKEN`.
4. **Змінні.** Settings → Environment Variables → додайте для Production (і Preview):
   - `ADMIN_PASSWORD` — пароль адміна (без пробілів);
   - `MONO_TOKEN` — токен Monobank;
   - `BASE_URL` — `https://назва-проєкту.vercel.app` (потім `https://neapollake.site`).
5. **Перевипуск.** Deployments → ⋯ біля останнього деплою → **Redeploy**. Змінні діють лише для нових деплоїв.
6. **Перевірка.** `https://ваш-сайт.vercel.app/api/health` має показати `"payment": true`, `"adminPassword": true`, `"storage": true`.
   - `storage: false` — база не підключена (крок 3);
   - `adminPassword: false` — змінної `ADMIN_PASSWORD` немає в Production або не було Redeploy;
   - `payment: false` — те саме для `MONO_TOKEN`.
7. Зайдіть на сайт → 🔑 → пароль. Зробіть тестове бронювання й оплату на малу суму.
8. **Домен.** Settings → Domains → Add `neapollake.site` і створіть у HOSTiQ DNS-записи, які покаже Vercel. Потім змініть `BASE_URL` на `https://neapollake.site` і зробіть Redeploy.

## Примітка про тариф
Безкоштовний тариф Vercel Hobby, за умовами сервісу, призначений для некомерційного використання. Сайт із прийомом оплат — комерційний, тому перевірте умови й тарифи на vercel.com/pricing.
