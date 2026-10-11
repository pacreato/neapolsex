// Neapol Lake — API для Vercel (Vercel Function + Upstash Redis через REST, без залежностей).
// Той самий контракт, що й у Node/Netlify-версіях: /api/state, /api/login, /api/site, /api/bookings, /api/mono/webhook …
const crypto = require("crypto");

const ENV = k => (process.env[k] || "").trim();
const RURL = () => ENV("KV_REST_API_URL") || ENV("UPSTASH_REDIS_REST_URL");
const RTOK = () => ENV("KV_REST_API_TOKEN") || ENV("UPSTASH_REDIS_REST_TOKEN");
const BASE = () => ENV("BASE_URL") || (ENV("VERCEL_PROJECT_PRODUCTION_URL") ? "https://" + ENV("VERCEL_PROJECT_PRODUCTION_URL") : "");
const HOLD_MS = 20 * 60 * 1000; // скільки неоплачена бронь тримає дату

// ---- Redis (Upstash REST): одна команда = один POST
async function redis(...cmd) {
  if (!RURL() || !RTOK()) throw new Error("Не підключено базу даних (Upstash Redis)");
  const r = await fetch(RURL(), { method: "POST", headers: { Authorization: "Bearer " + RTOK(), "Content-Type": "application/json" }, body: JSON.stringify(cmd) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error || "redis " + r.status);
  return j.result;
}
const getJ = async k => { const v = await redis("GET", k); return v ? JSON.parse(v) : null; };
const setJ = (k, v, ...opt) => redis("SET", k, JSON.stringify(v), ...opt);

// ---- токен адміна без стану (HMAC)
const SECRET = () => ENV("TOKEN_SECRET") || "nl|" + ENV("ADMIN_PASSWORD");
const sign = p => crypto.createHmac("sha256", SECRET()).update(p).digest("base64url");
const mkToken = () => { const p = Buffer.from(JSON.stringify({ exp: Date.now() + 12 * 3600e3 })).toString("base64url"); return p + "." + sign(p); };
const isAdmin = req => {
  const [p, s] = String(req.headers.authorization || "").replace("Bearer ", "").split(".");
  if (!p || !s) return false;
  const e = sign(p); if (s.length !== e.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(e))) return false;
  try { return JSON.parse(Buffer.from(p, "base64url").toString()).exp > Date.now(); } catch { return false; }
};

const taken = b => b && (b.paid || Date.now() - b.created < HOLD_MS);
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const overlapsWith = (list, sector, date, days, selfId) => { const end = addDays(date, days - 1);
  return list.filter(b => b.id !== selfId && b.sector === sector && taken(b) && b.date <= end && addDays(b.date, (b.days || 1) - 1) >= date); };
const getSite = async () => (await getJ("nl:site")) || { news: [], photos: [], comps: [] };
const compOn = (site, d) => (site.comps || []).find(c => d >= c.from && d <= c.to);
const payAmt = (site, pct) => { // 50% або 100% від першого рядка «Ціни на сезон» (доба на секторі)
  const r = site.prices && site.prices.season && site.prices.season[0];
  return Math.round((r ? parseInt(String(r.p).replace(/\s/g, "")) || 1200 : 1200) * pct / 100);
};
async function mono(p, opt = {}) {
  const r = await fetch((ENV("MONO_API") || "https://api.monobank.ua") + p, { ...opt, headers: { "X-Token": ENV("MONO_TOKEN"), "Content-Type": "application/json" } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(JSON.stringify(j));
  return j;
}
// Якщо вебхук Monobank не дійшов — самі перепитуємо статус рахунку, щоб оплачена бронь не втрачалась
async function reconcile(v, key, force) {
  if (v.paid || !v.invoiceId || !ENV("MONO_TOKEN")) return v;
  if (!force && (await redis("SET", "nl:chk:" + v.id, "1", "EX", "15", "NX")) === null) return v; // не частіше, ніж раз на 15 с
  try {
    const st = await mono("/api/merchant/invoice/status?invoiceId=" + encodeURIComponent(v.invoiceId));
    if (st.status === "success") { const cur = await getJ(key); if (!cur) return null; cur.paid = true; await setJ(key, cur); return cur; }
    if (["expired", "reversed"].includes(st.status)) { await redis("DEL", key); return null; }
  } catch (e) { console.error("reconcile:", e.message); }
  return v;
}
async function allBookings() {
  const keys = await redis("KEYS", "nl:b:*");
  const vals = keys.length ? await redis("MGET", ...keys) : [];
  const out = [];
  for (let i = 0; i < keys.length; i++) {
    let v = vals[i] ? JSON.parse(vals[i]) : null; if (!v) continue;
    const stale = !v.paid && Date.now() - v.created > HOLD_MS + 60000;
    v = await reconcile(v, keys[i], stale);                     // для прострочених — обов'язкова перевірка перед видаленням
    if (!v) continue;
    if (!v.paid && stale) { await redis("DEL", keys[i]); continue; }
    out.push(v);
  }
  return out;
}
const send = (res, code, obj) => { res.setHeader("Cache-Control", "no-store"); res.status(code).json(obj); };

module.exports = async (req, res) => {
  const p = String(req.url || "").split("?")[0].replace(/^\/api/, "") || "/", m = req.method;
  let body = req.body; if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } } body = body || {};
  try {
    if (m === "GET" && p === "/health") {
      let storage = true; try { await redis("PING"); } catch { storage = false; }
      return send(res, 200, { ok: true, payment: !!ENV("MONO_TOKEN"), adminPassword: !!ENV("ADMIN_PASSWORD"), baseUrl: BASE() || null, storage });
    }
    if (m === "GET" && p === "/state") {
      const adm = isAdmin(req), site = await getSite(), list = (await allBookings()).filter(b => adm || taken(b));
      return send(res, 200, { site, admin: adm, payment: !!ENV("MONO_TOKEN"), bookings: list.map(b => adm ? b : { sector: b.sector, date: b.date, days: b.days || 1, paid: true }) });
    }
    if (m === "POST" && p === "/login") {
      if (ENV("ADMIN_PASSWORD") && String(body.password || "").trim() === ENV("ADMIN_PASSWORD")) return send(res, 200, { token: mkToken() });
      await new Promise(r => setTimeout(r, 600));
      return send(res, 401, { error: "Невірний пароль" });
    }
    let mm;
    if (m === "GET" && (mm = p.match(/^\/photo\/(\d+)$/))) {
      const v = await redis("GET", "nl:p:" + mm[1]);
      if (!v) { res.status(404).end("Not found"); return; }
      res.setHeader("Content-Type", "image/jpeg"); res.setHeader("Cache-Control", "public, max-age=86400");
      res.status(200).send(Buffer.from(v, "base64")); return;
    }
    if (m === "POST" && p === "/site") {
      if (!isAdmin(req)) return send(res, 401, { error: "Потрібен вхід адміна" });
      try {
      const old = await getSite(), site = { news: body.news || [], comps: body.comps || [], photos: [] };
      if (body.prices) site.prices = body.prices;
      for (const ph of body.photos || []) {
        let src = String(ph.src || "");
        if (/^data:image\/(jpeg|png|webp);base64,/.test(src)) {
          const id = String(ph.id).replace(/\D/g, "") || String(Date.now());
          await redis("SET", "nl:p:" + id, src.split(",")[1]);
          src = "/api/photo/" + id;
        } else if (!/^\/api\/photo\/\d+$/.test(src)) continue;
        site.photos.push({ id: ph.id, src });
      }
      const keep = new Set(site.photos.map(x => x.src));
      for (const o of old.photos || []) if (!keep.has(o.src)) { const k = String(o.src).match(/^\/api\/photo\/(\d+)$/); if (k) await redis("DEL", "nl:p:" + k[1]); }
      await setJ("nl:site", site);
      return send(res, 200, { site });
      } catch (e) { console.error("site:", e.message); return send(res, 500, { error: "Не вдалося зберегти: " + e.message }); }
    }
    if (m === "POST" && p === "/bookings") {
      const site = await getSite(), b = body;
      const sector = +b.sector, date = String(b.date || "");
      const name = String(b.name || "").trim().slice(0, 80), phone = String(b.phone || "").trim().slice(0, 30);
      const adm = isAdmin(req) && !!b.admin, pct = +b.pct === 100 ? 100 : 50;
      if (!(sector >= 1 && sector <= 15) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date < today()) return send(res, 400, { error: "Невірні дані бронювання" });
      const days = Math.min(5, Math.max(1, parseInt(b.days) || 1));
      for (let i = 0; i < days; i++) if (compOn(site, addDays(date, i))) return send(res, 400, { error: "У ці дати проходять змагання" });
      if (!adm && (!name || !phone)) return send(res, 400, { error: "Заповніть ім'я та телефон" });
      const id = sector + "_" + date, key = "nl:b:" + id, ex = await getJ(key);
      if (taken(ex) || overlapsWith(await allBookings(), sector, date, days, id).length) return send(res, 409, { error: "Цей сектор на ці дати вже заброньовано" });
      if (ex) await redis("DEL", key);
      const bk = { id, sector, date, name: name || "Адмін", phone: phone || "—", days, amount: adm ? 0 : payAmt(site, pct) * days, paid: adm, created: Date.now() };
      const w = await setJ(key, bk, "NX"); // атомарно: запис лише якщо ключа ще немає
      if (w === null) return send(res, 409, { error: "Цей сектор на цю дату вже заброньовано" });
      const rival = overlapsWith(await allBookings(), sector, date, days, id).find(x => x.created < bk.created || (x.created === bk.created && x.id < id));
      if (rival) { await redis("DEL", key); return send(res, 409, { error: "Цей сектор на ці дати вже заброньовано" }); }
      if (!adm && ENV("MONO_TOKEN")) {
        try {
          const inv = await mono("/api/merchant/invoice/create", { method: "POST", body: JSON.stringify({
            amount: bk.amount * 100, ccy: 980, validity: HOLD_MS / 1000,
            merchantPaymInfo: { reference: id, destination: `Оплата ${pct}% — сектор ${sector}, ${date}, ${days} діб` },
            redirectUrl: BASE() + "/?paid=1", webHookUrl: BASE() + "/api/mono/webhook" }) });
          bk.invoiceId = inv.invoiceId; await setJ(key, bk);
          return send(res, 200, { ok: true, pageUrl: inv.pageUrl });
        } catch (e) {
          console.error("Monobank:", e.message); await redis("DEL", key);
          return send(res, 502, { error: "Не вдалося створити рахунок на оплату. Спробуйте пізніше або зв'яжіться з нами." });
        }
      }
      return send(res, 200, { ok: true });
    }
    if (m === "POST" && p === "/mono/webhook") {
      const bk = (await allBookings()).find(x => x.invoiceId && x.invoiceId === body.invoiceId);
      if (bk && ENV("MONO_TOKEN")) {
        try { // не довіряємо тілу вебхука — перепитуємо статус у Monobank
          const st = await mono("/api/merchant/invoice/status?invoiceId=" + encodeURIComponent(body.invoiceId));
          if (st.status === "success") { const cur = await getJ("nl:b:" + bk.id); if (cur) { cur.paid = true; await setJ("nl:b:" + bk.id, cur); } }
          else if (["expired", "reversed"].includes(st.status) && !bk.paid) await redis("DEL", "nl:b:" + bk.id);
        } catch (e) { console.error("Webhook:", e.message); }
      }
      return send(res, 200, { ok: true });
    }
    if ((mm = p.match(/^\/bookings\/(\d+_\d{4}-\d{2}-\d{2})(\/paid)?$/))) {
      if (!isAdmin(req)) return send(res, 401, { error: "Потрібен вхід адміна" });
      const key = "nl:b:" + mm[1];
      if (m === "DELETE") { await redis("DEL", key); return send(res, 200, { ok: true }); }
      if (m === "PATCH" && mm[2]) { const v = await getJ(key); if (v) { v.paid = true; await setJ(key, v); } return send(res, 200, { ok: true }); }
    }
    return send(res, 404, { error: "Не знайдено" });
  } catch (e) { console.error(e); return send(res, 500, { error: "Помилка сервера" }); }
};
