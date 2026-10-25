// Card Play backend (Cloudflare Worker + D1 database)
//  - store & admin data (products, sections, banners, settings, users/wallets, orders, top-ups, tickets, staff)
//  - every money operation is checked and applied here, atomically
//  - admin push notifications, supplier (Libya Play) integration, background jobs (cron)
//  - one-time move of the old data (runs by itself until it finishes)
// Secrets (Cloudflare dashboard): FIREBASE_SA (service-account JSON), LP_KEY, LP_EMAIL
// Vars (wrangler.jsonc): FB_API_KEY, FB_PROJECT

const LP = "https://api.libyaplay.com/portal";
const PROJECT_DEF = "cd-card-87365";
const PUBLIC_COLS = ["products", "categories", "banners", "settings"];
let cached = { token: "", exp: 0 };
let schemaReady = false;
const JW = { keys: {}, exp: 0 };
let pubMem = { at: 0, text: "" };

class UErr extends Error {}
const UE = m => { throw new UErr(m); };

export default {
  async fetch(req, env, ectx) {
    const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
    const json = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { ...cors, "Content-Type": "application/json" } });
    const raw = (txt, extra = {}) => new Response(txt, { headers: { ...cors, "Content-Type": "application/json", ...extra } });
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    try {
      await schema(env);
      const ctx = makeCtx(env, req, ectx);
      const url = new URL(req.url);
      if (req.method === "GET") {
        if (url.pathname === "/public") return raw(await publicText(ctx), { "Cache-Control": "public, max-age=15" });
        if (url.pathname === "/status") return new Response(await statusPage(ctx), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
        return json({ ok: true, service: "cardplay" });
      }
      if (req.method !== "POST") return json({ ok: false }, 405);
      const body = JSON.parse(await req.text() || "{}");
      const a = body.action || "";

      // ---------- public ----------
      if (!a) {   // old pages ping after a new order / top-up
        const { type, id } = body;
        if (!["orders", "topups"].includes(type) || !validId(id)) return json({ ok: false }, 400);
        return json({ ok: true, ...(await onNew(ctx, type, id)) });
      }
      if (a === "sup_check") {
        if (!validId(body.id)) return json({ ok: false }, 400);
        return json({ ok: true, ...(await syncOrders(ctx, [body.id], true)) });
      }

      // ---------- signed-in ----------
      const user = await verifyToken(ctx, body.token || body.idToken);
      if (!user) return json({ ok: false, error: "unauthorized" }, 401);

      if (a === "sync") return raw(await userSync(ctx, user, body));
      if (a === "profile") return json({ ok: true, ...(await setProfile(ctx, user, body)) });
      if (a === "defwallet") return json({ ok: true, ...(await setDefWallet(ctx, user, body)) });
      if (a === "buy") return json({ ok: true, ...(await buy(ctx, user, body)) });
      if (a === "topup") return json({ ok: true, ...(await topup(ctx, user, body)) });
      if (a === "ticket") return json({ ok: true, ...(await ticket(ctx, user, body)) });

      // ---------- admin ----------
      const who = await adminOf(ctx, user.uid);
      if (!who) return json({ ok: false, error: "unauthorized" }, 401);
      const need = p => { if (!who.can(p)) throw Object.assign(new Error("forbidden"), { forbidden: true }); };

      if (a === "admin_me") return json({ ok: true, role: who.owner ? "owner" : "staff", perms: who.perms, mig: await migState(ctx) });
      if (a === "admin_sync") return raw(await adminSync(ctx, who, body));
      if (a === "admin_ops") return json({ ok: true, ...(await adminOps(ctx, who, body.ops)) });
      if (a === "admin_shot") { need("topups"); return json({ ok: true, shot: await shotOf(ctx, body.id) }); }
      if (a === "order_refund") { need("orders"); return json({ ok: true, ...(await orderRefund(ctx, body)) }); }
      if (a === "topup_approve") { need("topups"); return json({ ok: true, ...(await topupApprove(ctx, body)) }); }
      if (a === "user_adjust") { need("balance"); return json({ ok: true, ...(await userAdjust(ctx, body)) }); }
      if (a === "mig_run") { if (!who.owner) need("__owner"); return json({ ok: true, mig: await migrateStep(ctx) }); }

      if (a === "sup_products") { need("products"); return json({ ok: true, products: flattenTree(await supTree(ctx)) }); }
      if (a === "sup_probe") { need("orders"); const r1 = await supProbe(ctx, String(body.sid || "")); return json({ ok: true, ...r1, ...(r1.found ? {} : { byName: await supProbeByName(ctx, { id: body.sid, name: body.name, type: body.type, cost: Number(body.cost) || 0 }) }) }); }
      if (a === "sup_tree") { need("products"); return json({ ok: true, tree: await supTree(ctx) }); }
      if (a === "sup_balance") {
        if (!who.can("settings") && !who.can("products")) need("settings");
        const r = await lp(ctx, "GET", "/general/profile");
        const d = r.data?.data || {};
        return json({ ok: r.ok, status: r.status, balance: d.wallet ?? null, currency: d.currency_code || "", name: d.name || "" });
      }
      if (a === "sup_exec") { need("orders"); if (!validId(body.id)) return json({ ok: false }, 400); return json({ ok: true, ...(await execOrder(ctx, body.id, !!body.manual)) }); }
      if (a === "sup_sync") { need("orders"); return json({ ok: true, ...(await syncOrders(ctx, null, false)) }); }
      return json({ ok: false, error: "unknown action" }, 400);
    } catch (e) {
      if (e instanceof UErr) return json({ ok: false, msg: e.message }, 400);
      if (e && e.forbidden) return json({ ok: false, error: "forbidden" }, 403);
      console.error(e);
      return json({ ok: false, error: "server" }, 500);
    }
  },
  async scheduled(ev, env, ectx) {
    ectx.waitUntil((async () => {
      await schema(env);
      const ctx = makeCtx(env, null, ectx);
      try { await migrateStep(ctx); } catch (e) { console.error("mig", e); }
      try { await supplierJobs(ctx); } catch (e) { console.error("sup", e); }
    })());
  }
};

const validId = id => /^[A-Za-z0-9]{10,40}$/.test(id || "");
const validKey = k => /^[A-Za-z0-9_-]{1,20}$/.test(k || "");
const newId = () => { const c = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", b = crypto.getRandomValues(new Uint8Array(20)); let s = ""; b.forEach(x => s += c[x % 62]); return s; };
const str = (v, max) => String(v ?? "").slice(0, max);

/* ================= database ================= */
async function schema(env) {
  if (schemaReady) return;
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS docs (col TEXT NOT NULL, id TEXT NOT NULL, uid TEXT, data TEXT NOT NULL, v INTEGER NOT NULL DEFAULT 1, created INTEGER, updated INTEGER NOT NULL, del INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (col, id))"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS docs_col_upd ON docs (col, updated)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS docs_col_created ON docs (col, created)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS docs_upd ON docs (updated)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS docs_uid ON docs (uid, col, updated)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS shots (id TEXT PRIMARY KEY, data TEXT)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)")
  ]);
  schemaReady = true;
}
function makeCtx(env, req, ectx) {
  return {
    env, db: env.DB,
    site: ((req && req.headers.get("Origin")) || "https://cardplay.com.ly").replace(/\/+$/, ""),
    wait: p => ectx.waitUntil(Promise.resolve(p).catch(e => console.error(e)))
  };
}
const uidOf = (col, id, data) => (col === "users" || col === "admins") ? id : (["orders", "topups", "tickets"].includes(col) ? String(data?.uid || "") : null);
async function getD(ctx, col, id) {
  const r = await ctx.db.prepare("SELECT data, v, created, updated FROM docs WHERE col = ?1 AND id = ?2 AND del = 0").bind(col, id).first();
  return r ? { id, v: r.v, created: r.created, updated: r.updated, data: JSON.parse(r.data) } : null;
}
function putS(ctx, col, id, data, created) {
  const t = Date.now();
  return ctx.db.prepare("INSERT INTO docs (col, id, uid, data, v, created, updated, del) VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6, 0) ON CONFLICT (col, id) DO UPDATE SET uid = excluded.uid, data = excluded.data, v = docs.v + 1, updated = excluded.updated, del = 0")
    .bind(col, id, uidOf(col, id, data), JSON.stringify(data), created || Number(data?.createdAt) || t, t);
}
function updS(ctx, col, id, data, v) {
  return ctx.db.prepare("UPDATE docs SET data = ?1, uid = ?2, v = v + 1, updated = ?3 WHERE col = ?4 AND id = ?5 AND v = ?6 AND del = 0")
    .bind(JSON.stringify(data), uidOf(col, id, data), Date.now(), col, id, v);
}
function delS(ctx, col, id) {
  return ctx.db.prepare("UPDATE docs SET del = 1, data = '{}', v = v + 1, updated = ?1 WHERE col = ?2 AND id = ?3").bind(Date.now(), col, id);
}
// merge top-level fields; with expectV the write only happens if nobody changed the doc in between
async function patchD(ctx, col, id, obj, expectV) {
  for (let i = 0; i < 4; i++) {
    const d = await getD(ctx, col, id);
    if (!d) return false;
    if (expectV != null && d.v !== expectV) return false;
    const r = await updS(ctx, col, id, { ...d.data, ...obj }, d.v).run();
    if (r.meta.changes === 1) return true;
    if (expectV != null) return false;
  }
  return false;
}
// SQL expression: data with <path> increased by ?amt (creates the wallets map if missing)
const addSQL = (path) => `json_set(json_set(data, '$.wallets', json(coalesce(json_extract(data, '$.wallets'), '{}'))), ${path}, coalesce(json_extract(data, ${path}), 0) + ?2)`;
const walletPath = w => w ? "$.wallets." + w : "$.balance";

/* ================= sign-in tokens ================= */
const b64dec = s => atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
const b64bytes = s => Uint8Array.from(b64dec(s), c => c.charCodeAt(0));
async function verifyToken(ctx, tok) {
  if (!tok || typeof tok !== "string") return null;
  if (ctx.env.TEST_AUTH === "1" && tok.startsWith("test:")) { const [, uid, email = "", name = ""] = tok.split(":"); return uid ? { uid, email, name, picture: "" } : null; }
  const parts = tok.split(".");
  if (parts.length !== 3) return null;
  let hd, pl;
  try { hd = JSON.parse(b64dec(parts[0])); pl = JSON.parse(b64dec(parts[1])); } catch { return null; }
  const proj = ctx.env.FB_PROJECT || PROJECT_DEF, now = Date.now() / 1000;
  if (hd.alg !== "RS256" || pl.aud !== proj || pl.iss !== `https://securetoken.google.com/${proj}` || !pl.sub || !(pl.exp > now) || pl.iat > now + 300) return null;
  const key = await jwk(hd.kid);
  if (!key) return null;
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64bytes(parts[2]), new TextEncoder().encode(parts[0] + "." + parts[1]));
  return ok ? { uid: pl.sub, email: pl.email || "", name: pl.name || "", picture: pl.picture || "" } : null;
}
async function jwk(kid) {
  if (!kid) return null;
  if (!JW.keys[kid] || Date.now() > JW.exp) {
    const r = await fetch("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com");
    const j = await r.json();
    const keys = {};
    for (const k of j.keys || []) keys[k.kid] = await crypto.subtle.importKey("jwk", k, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    JW.keys = keys; JW.exp = Date.now() + 3600 * 1000;
  }
  return JW.keys[kid] || null;
}
async function adminOf(ctx, uid) {
  const a = await getD(ctx, "admins", uid);
  if (!a) return null;
  const owner = a.data.role !== "staff";
  const perms = Array.isArray(a.data.perms) ? a.data.perms : ["orders", "topups", "tickets"];
  return { uid, owner, perms, can: p => owner || perms.includes(p) };
}

/* ================= public data (products, sections, banners, settings) ================= */
// built once after each change and kept ready, so a visit costs one small read
async function publicText(ctx) {
  if (pubMem.text && Date.now() - pubMem.at < 10000) return pubMem.text;
  const rows = (await ctx.db.prepare("SELECT k, v FROM meta WHERE k LIKE 'pub%' ORDER BY k").all()).results || [];
  const head = rows.find(r => r.k === "pub");
  let text = "";
  if (head) {
    const h = JSON.parse(head.v);
    const parts = [];
    for (let i = 0; i < h.n; i++) { const p = rows.find(r => r.k === "pub_" + i); if (!p) { parts.length = 0; break; } parts.push(p.v); }
    if (parts.length === h.n) text = parts.join("");
  }
  if (!text) text = await buildPublic(ctx);
  pubMem = { at: Date.now(), text };
  return text;
}
async function buildPublic(ctx) {
  const rows = (await ctx.db.prepare("SELECT col, id, data FROM docs WHERE col IN ('products', 'categories', 'banners', 'settings') AND del = 0").all()).results || [];
  const clean = o => { const r = {}; for (const k in o) if (!/^(sup|cost|createdAt|updatedAt)/i.test(k)) r[k] = o[k]; return r; };
  const out = { ok: true, products: [], cats: [], banners: [], settings: {} };
  for (const r of rows) {
    const d = JSON.parse(r.data);
    if (r.col === "settings") { if (r.id === "app") { const s = clean(d); out.settings = s; } continue; }
    if (d.active === false) continue;
    if (r.col === "products") out.products.push({ id: r.id, ...clean(d), options: (d.options || []).map(clean) });
    else if (r.col === "categories") out.cats.push({ id: r.id, ...clean(d) });
    else out.banners.push({ id: r.id, ...clean(d) });
  }
  const text = JSON.stringify(out);
  const CH = 1500000, n = Math.max(1, Math.ceil(text.length / CH)), st = [ctx.db.prepare("DELETE FROM meta WHERE k LIKE 'pub%'")];
  for (let i = 0; i < n; i++) st.push(ctx.db.prepare("INSERT INTO meta (k, v) VALUES (?1, ?2)").bind("pub_" + i, text.slice(i * CH, (i + 1) * CH)));
  st.push(ctx.db.prepare("INSERT INTO meta (k, v) VALUES ('pub', ?1)").bind(JSON.stringify({ n, at: Date.now() })));
  await ctx.db.batch(st);
  return text;
}
const pubDirty = ctx => { pubMem = { at: 0, text: "" }; return ctx.db.prepare("DELETE FROM meta WHERE k = 'pub'"); };

/* ================= customer ================= */
async function settingsOf(ctx) { return (await getD(ctx, "settings", "app"))?.data || {}; }
async function createUser(ctx, user, profile) {
  const p = profile && typeof profile === "object" ? profile : {};
  const t = Date.now();
  const data = {
    name: str(p.name || user.name || (user.email || "").split("@")[0] || "مستخدم", 60),
    email: user.email || "", phone: str(p.phone || "", 20), photo: str(user.picture || "", 500),
    short: "CP" + String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000)),
    wallets: {}, defWallet: "", createdAt: t
  };
  await ctx.db.prepare("INSERT OR IGNORE INTO docs (col, id, uid, data, v, created, updated, del) VALUES ('users', ?1, ?1, ?2, 1, ?3, ?3, 0)").bind(user.uid, JSON.stringify(data), t).run();
  return await getD(ctx, "users", user.uid);
}
const rowsJSON = rows => rows.map(r => `{"c":${JSON.stringify(r.col)},"i":${JSON.stringify(r.id)},"x":${r.del ? 1 : 0},"u":${r.updated},"d":${r.del ? "{}" : r.data}}`).join(",");
async function userSync(ctx, user, body) {
  const t = Date.now(), since = Number(body.since) || 0;
  let me = await getD(ctx, "users", user.uid);
  if (!me) me = await createUser(ctx, user, body.profile);
  let rows;
  if (since > 0) {
    rows = (await ctx.db.prepare("SELECT col, id, data, updated, del FROM docs WHERE uid = ?1 AND col IN ('orders', 'topups', 'tickets') AND updated > ?2 ORDER BY updated LIMIT 300").bind(user.uid, since).all()).results || [];
  } else {
    const q = col => ctx.db.prepare("SELECT col, id, data, updated, del FROM docs WHERE uid = ?1 AND col = ?2 AND del = 0 ORDER BY updated DESC LIMIT 200").bind(user.uid, col);
    rows = (await ctx.db.batch([q("orders"), q("topups"), q("tickets")])).flatMap(r => r.results || []);
  }
  const meTxt = me && (!since || me.updated > since) ? JSON.stringify({ id: user.uid, ...me.data }) : "null";
  return `{"ok":true,"now":${t},"me":${meTxt},"docs":[${rowsJSON(rows)}]}`;
}
async function setProfile(ctx, user, b) {
  const name = String(b.name || "").trim(), phone = String(b.phone || "").trim();
  if (name.length < 2 || name.length > 60) UE("اكتب اسمك");
  if (phone.length > 20) UE("رقم الهاتف طويل");
  if (!(await patchD(ctx, "users", user.uid, { name, phone }))) UE("تعذر الحفظ");
  return {};
}
async function setDefWallet(ctx, user, b) {
  if (!validKey(b.k)) UE("محفظة غير صحيحة");
  if (!(await patchD(ctx, "users", user.uid, { defWallet: b.k }))) UE("تعذر التعديل");
  return {};
}
const priceFor = (o, k) => Number(o?.prices && (k in o.prices) ? o.prices[k] : (o?.price || 0)) || 0;
async function buy(ctx, user, b) {
  const pid = String(b.pid || ""), idx = Number(b.idx), wk = String(b.wk || ""), input = String(b.input || "").trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(pid) || !Number.isInteger(idx) || idx < 0 || !validKey(wk)) UE("طلب غير صحيح");
  if (input.length > 200) UE("البيانات المدخلة طويلة");
  const [p, me, st] = await Promise.all([getD(ctx, "products", pid), getD(ctx, "users", user.uid), settingsOf(ctx)]);
  if (!p || p.data.active === false) UE("المنتج غير متاح حالياً");
  const o = (p.data.options || [])[idx];
  if (!o || o.off) UE("الباقة غير متوفرة حالياً");
  const w = (st.payments || []).find(x => x.key === wk);
  if (st.payments?.length && (!w || w.enabled === false)) UE("المحفظة غير متاحة");
  const price = Math.round(priceFor(o, wk));
  if (!(price > 0)) UE("الباقة غير متوفرة بهذه المحفظة");
  if (p.data.needsInput && !input) UE(`اكتب ${p.data.inputLabel || "ID اللاعب"}`);
  if (!me) UE("الحساب غير جاهز، حدّث الصفحة");
  if ((Number(me.data.wallets?.[wk]) || 0) < price) UE("رصيد المحفظة غير كافي");
  const t = Date.now(), id = newId();
  const order = { uid: user.uid, uName: me.data.name || "", uShort: me.data.short || "", productId: pid, productName: p.data.name || "",
    optionIndex: idx, optionLabel: o.label || "", price, wallet: wk, cur: w?.cur || "د.ل", input, no: String(t).slice(-7),
    status: "pending", createdAt: t, updatedAt: t };
  const path = "$.wallets." + wk;
  const res = await ctx.db.batch([
    ctx.db.prepare(`UPDATE docs SET data = json_set(data, ?1, coalesce(json_extract(data, ?1), 0) - ?2), v = v + 1, updated = ?3 WHERE col = 'users' AND id = ?4 AND del = 0 AND coalesce(json_extract(data, ?1), 0) >= ?2`).bind(path, price, t, user.uid),
    ctx.db.prepare("INSERT INTO docs (col, id, uid, data, v, created, updated, del) SELECT 'orders', ?1, ?2, ?3, 1, ?4, ?4, 0 WHERE changes() = 1").bind(id, user.uid, JSON.stringify(order), t)
  ]);
  if (res[0].meta.changes !== 1 || res[1].meta.changes !== 1) UE("رصيد المحفظة غير كافي");
  ctx.wait(onNew(ctx, "orders", id));
  return { id };
}
async function topup(ctx, user, b) {
  const wk = String(b.wallet || ""), amount = Number(b.amount), note = str(b.note, 300).trim(), shot = String(b.shot || "");
  if (!validKey(wk) || wk === "admin") UE("محفظة غير صحيحة");
  if (!Number.isInteger(amount) || amount <= 0 || amount > 10000000) UE("اكتب القيمة");
  if (shot && (shot.length > 900000 || !shot.startsWith("data:image/"))) UE("الصورة كبيرة، اختر صورة أصغر");
  const fields = {};
  if (b.fields && typeof b.fields === "object") Object.entries(b.fields).slice(0, 12).forEach(([k, v]) => fields[str(k, 60)] = str(v, 150));
  const [st, me] = await Promise.all([settingsOf(ctx), getD(ctx, "users", user.uid)]);
  if (!me) UE("الحساب غير جاهز، حدّث الصفحة");
  const w = (st.payments || []).find(x => x.key === wk);
  if (st.payments?.length && (!w || w.enabled === false)) UE("المحفظة غير متاحة");
  const t = Date.now(), id = newId();
  const data = { uid: user.uid, uName: me.data.name || "", uShort: me.data.short || "", method: wk, methodName: w?.name || wk, wallet: wk,
    cur: w?.cur || "د.ل", amount, fields, hasShot: !!shot, note, status: "pending", createdAt: t, updatedAt: t };
  const st2 = [putS(ctx, "topups", id, data, t)];
  if (shot) st2.push(ctx.db.prepare("INSERT OR REPLACE INTO shots (id, data) VALUES (?1, ?2)").bind(id, shot));
  await ctx.db.batch(st2);
  ctx.wait(onNew(ctx, "topups", id));
  return { id };
}
async function ticket(ctx, user, b) {
  const message = str(b.message, 1500).trim();
  if (message.length < 5) UE("اكتب رسالتك بالتفصيل");
  const me = await getD(ctx, "users", user.uid);
  const t = Date.now(), id = newId();
  await putS(ctx, "tickets", id, { uid: user.uid, uName: me?.data.name || "", uShort: me?.data.short || "", type: str(b.type, 60), message, status: "open", reply: "", createdAt: t, updatedAt: t }, t).run();
  return { id };
}

/* ================= admin ================= */
async function adminSync(ctx, who, body) {
  const t = Date.now(), since = Number(body.since) || 0;
  let rows;
  if (since > 0) {
    rows = (await ctx.db.prepare("SELECT col, id, data, updated, del FROM docs WHERE updated > ?1 AND col != 'adminTokens' ORDER BY updated LIMIT 400").bind(since).all()).results || [];
  } else {
    const last = (col, n) => ctx.db.prepare("SELECT col, id, data, updated, del FROM docs WHERE col = ?1 AND del = 0 ORDER BY created DESC LIMIT ?2").bind(col, n);
    rows = (await ctx.db.batch([
      ctx.db.prepare("SELECT col, id, data, updated, del FROM docs WHERE col IN ('products', 'categories', 'banners', 'settings', 'users', 'admins') AND del = 0"),
      last("orders", 150), last("topups", 100), last("tickets", 300)
    ])).flatMap(r => r.results || []);
  }
  const more = since > 0 && rows.length >= 400;
  const until = more ? rows[rows.length - 1].updated - 1 : t;
  return `{"ok":true,"now":${until},"more":${more},"docs":[${rowsJSON(rows)}]}`;
}
function resolveSentinels(v, t) {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    if (v.__ts) return t;
    const o = {}; for (const k in v) o[k] = resolveSentinels(v[k], t); return o;
  }
  if (Array.isArray(v)) return v.map(x => resolveSentinels(x, t));
  return v;
}
function applyUpdate(base, upd, t) {
  const out = JSON.parse(JSON.stringify(base));
  for (const key in upd) {
    const path = key.split("."), val = upd[key];
    let o = out;
    for (let i = 0; i < path.length - 1; i++) { if (!o[path[i]] || typeof o[path[i]] !== "object") o[path[i]] = {}; o = o[path[i]]; }
    const last = path[path.length - 1];
    if (val && typeof val === "object" && "__inc" in val) o[last] = (Number(o[last]) || 0) + Number(val.__inc || 0);
    else if (val && typeof val === "object" && val.__del) delete o[last];
    else o[last] = resolveSentinels(val, t);
  }
  return out;
}
const OP_PERM = { products: "products", categories: "products", banners: "banners", settings: "settings", orders: "orders", topups: "topups", tickets: "tickets" };
async function adminOps(ctx, who, ops) {
  if (!Array.isArray(ops) || !ops.length || ops.length > 150) UE("عملية غير صحيحة");
  const t = Date.now();
  const deny = () => { throw Object.assign(new Error("forbidden"), { forbidden: true }); };
  for (const op of ops) {
    if (!op || !["set", "update", "delete"].includes(op.op)) UE("عملية غير صحيحة");
    const { col, id } = op;
    if (!/^[A-Za-z0-9_:.\-]{1,300}$/.test(id || "")) UE("معرّف غير صحيح");
    if (op.op !== "delete" && (!op.data || typeof op.data !== "object")) UE("بيانات ناقصة");
    if (col === "adminTokens") { if (op.op === "set") op.data = { token: str(op.data.token, 400), uid: who.uid, ua: str(op.data.ua, 150), createdAt: t }; continue; }
    if (col === "admins") {
      if (!who.owner || id === who.uid) deny();
      if (op.op === "delete") { const a = await getD(ctx, "admins", id); if (a && a.data.role !== "staff") deny(); continue; }
      const d = op.op === "set" ? op.data : null;
      if (d && (d.role !== "staff" || Object.keys(d).some(k => !["role", "name", "email", "perms", "addedAt"].includes(k)) || !Array.isArray(d.perms || []))) deny();
      if (op.op === "update" && Object.keys(op.data).some(k => k !== "perms")) deny();
      continue;
    }
    const perm = OP_PERM[col];
    if (!perm || !who.can(perm)) deny();
    if (["orders", "topups", "tickets"].includes(col) && op.op === "set") deny();
  }
  // current versions of the docs being updated
  const upd = ops.filter(o => o.op === "update");
  const cur = new Map();
  if (upd.length) {
    const res = await ctx.db.batch(upd.map(o => ctx.db.prepare("SELECT col, id, data, v FROM docs WHERE col = ?1 AND id = ?2 AND del = 0").bind(o.col, o.id)));
    res.forEach(r => (r.results || []).forEach(x => cur.set(x.col + "/" + x.id, x)));
  }
  const st = [];
  let touchedPublic = false;
  for (const op of ops) {
    if (PUBLIC_COLS.includes(op.col)) touchedPublic = true;
    if (op.op === "delete") { st.push(delS(ctx, op.col, op.id)); if (op.col === "topups") st.push(ctx.db.prepare("DELETE FROM shots WHERE id = ?1").bind(op.id)); continue; }
    if (op.op === "set") { const data = resolveSentinels(op.data, t); st.push(putS(ctx, op.col, op.id, data, Number(data.createdAt) || t)); continue; }
    const c = cur.get(op.col + "/" + op.id);
    if (!c) continue;
    const data = applyUpdate(JSON.parse(c.data), op.data, t);
    st.push(ctx.db.prepare("UPDATE docs SET data = ?1, uid = ?2, v = v + 1, updated = ?3 WHERE col = ?4 AND id = ?5 AND del = 0").bind(JSON.stringify(data), uidOf(op.col, op.id, data), t, op.col, op.id));
    cur.set(op.col + "/" + op.id, { ...c, data: JSON.stringify(data) });
  }
  if (touchedPublic) st.push(pubDirty(ctx));
  if (st.length) await ctx.db.batch(st);
  return { n: st.length };
}
async function orderRefund(ctx, b) {
  if (!validId(b.id)) UE("طلب غير صحيح");
  if (!(await refundCore(ctx, b.id, str(b.note, 300)))) UE("الطلب تغيّر، حاول مرة أخرى");
  return {};
}
// cancel + money back to the same wallet, in one step (false if the order changed meanwhile)
async function refundCore(ctx, id, note, extra = {}) {
  const o = await getD(ctx, "orders", id);
  if (!o) UE("الطلب غير موجود");
  if (o.data.status === "cancelled") UE("الطلب ملغي مسبقاً");
  const w = o.data.wallet || "";
  if (w && !validKey(w)) UE("محفظة غير صحيحة");
  const t = Date.now();
  const nd = { ...o.data, ...extra, status: "cancelled", refunded: true, delivery: "", adminNote: note, updatedAt: t };
  const res = await ctx.db.batch([
    ctx.db.prepare("UPDATE docs SET data = ?1, v = v + 1, updated = ?2 WHERE col = 'orders' AND id = ?3 AND v = ?4 AND del = 0").bind(JSON.stringify(nd), t, id, o.v),
    ctx.db.prepare(`UPDATE docs SET data = ${addSQL("?1")}, v = v + 1, updated = ?3 WHERE col = 'users' AND id = ?4 AND changes() = 1`).bind(walletPath(w), Number(o.data.price) || 0, t, o.data.uid)
  ]);
  return res[0].meta.changes === 1;
}
async function topupApprove(ctx, b) {
  if (!validId(b.id)) UE("طلب غير صحيح");
  const amount = Number(b.amount);
  if (!Number.isInteger(amount) || amount <= 0) UE("مبلغ غير صحيح");
  const tp = await getD(ctx, "topups", b.id);
  if (!tp) UE("الطلب غير موجود");
  if (tp.data.status !== "pending") UE("تمت معالجة الطلب مسبقاً");
  const w = tp.data.wallet || tp.data.method;
  if (!validKey(w)) UE("محفظة غير صحيحة");
  const t = Date.now();
  const nd = { ...tp.data, status: "approved", amount, updatedAt: t };
  const res = await ctx.db.batch([
    ctx.db.prepare("UPDATE docs SET data = ?1, v = v + 1, updated = ?2 WHERE col = 'topups' AND id = ?3 AND v = ?4 AND del = 0").bind(JSON.stringify(nd), t, b.id, tp.v),
    ctx.db.prepare(`UPDATE docs SET data = ${addSQL("?1")}, v = v + 1, updated = ?3 WHERE col = 'users' AND id = ?4 AND changes() = 1`).bind(walletPath(w), amount, t, tp.data.uid)
  ]);
  if (res[0].meta.changes !== 1) UE("تمت معالجة الطلب مسبقاً");
  if (res[1].meta.changes !== 1) UE("حساب الزبون غير موجود");
  return {};
}
async function userAdjust(ctx, b) {
  const uid = String(b.uid || ""), w = String(b.wallet || ""), amount = Number(b.amount);
  if (!/^[A-Za-z0-9]{6,64}$/.test(uid) || !validKey(w) || !Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 100000000) UE("بيانات غير صحيحة");
  const [u, st] = await Promise.all([getD(ctx, "users", uid), settingsOf(ctx)]);
  if (!u) UE("الحساب غير موجود");
  const wp = (st.payments || []).find(x => x.key === w);
  const t = Date.now(), id = newId(), path = walletPath(w);
  const rec = { uid, uName: u.data.name || "", uShort: u.data.short || "", method: "admin", methodName: "الإدارة", wallet: w, cur: wp?.cur || "د.ل", amount, note: str(b.note, 300), status: "approved", createdAt: t, updatedAt: t };
  const res = await ctx.db.batch([
    ctx.db.prepare(`UPDATE docs SET data = ${addSQL("?1")}, v = v + 1, updated = ?3 WHERE col = 'users' AND id = ?4 AND del = 0 AND coalesce(json_extract(data, ?1), 0) + ?2 >= 0`).bind(path, amount, t, uid),
    ctx.db.prepare("INSERT INTO docs (col, id, uid, data, v, created, updated, del) SELECT 'topups', ?1, ?2, ?3, 1, ?4, ?4, 0 WHERE changes() = 1").bind(id, uid, JSON.stringify(rec), t)
  ]);
  if (res[0].meta.changes !== 1) UE("رصيد المحفظة لا يكفي للخصم");
  return {};
}
async function shotOf(ctx, id) {
  if (!validId(id)) return "";
  const r = await ctx.db.prepare("SELECT data FROM shots WHERE id = ?1").bind(id).first();
  if (r) return r.data || "";
  // older top-ups: fetch the receipt from the old database once and keep it
  if (!ctx.env.FIREBASE_SA) return "";
  try {
    const f = await fsFetch(ctx, `topups/${id}?mask.fieldPaths=shot`);
    if (!f.ok) return "";
    const shot = (await f.json()).fields?.shot?.stringValue || "";
    if (shot) await ctx.db.prepare("INSERT OR REPLACE INTO shots (id, data) VALUES (?1, ?2)").bind(id, shot).run();
    return shot;
  } catch { return ""; }
}

/* ================= moving the old data (runs by itself until done) ================= */
// order = importance: staff first (so the panel opens), then balances, then catalogue and history.
// image-heavy collections go in small pages so each run stays light.
const MIG = [["admins", 50], ["settings", 10], ["users", 150], ["products", 20], ["categories", 30], ["banners", 5], ["orders", 150], ["topups", 150], ["tickets", 100]];
const TOPUP_FIELDS = ["uid", "uName", "uShort", "method", "methodName", "wallet", "cur", "amount", "fields", "note", "status", "createdAt", "updatedAt", "adminNote", "notified"];
async function migState(ctx) {
  const r = await ctx.db.prepare("SELECT v FROM meta WHERE k = 'mig'").first();
  return r ? JSON.parse(r.v) : { i: 0, t: "", n: 0, counts: {} };
}
const migSave = (ctx, m) => ctx.db.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('mig', ?1)").bind(JSON.stringify(m));
// only one runner at a time (cron, admin page and status page can all ask)
async function migLock(ctx) {
  const t = Date.now(), until = t + 45000;
  const r = await ctx.db.prepare("INSERT INTO meta (k, v) VALUES ('miglock', ?1) ON CONFLICT (k) DO UPDATE SET v = excluded.v WHERE CAST(meta.v AS INTEGER) < ?2").bind(String(until), t).run();
  return r.meta.changes === 1 ? String(until) : "";
}
async function migrateStep(ctx) {
  let m = await migState(ctx);
  if (m.done || !ctx.env.FIREBASE_SA) return m;
  const lock = await migLock(ctx);
  if (!lock) return { ...m, busy: true };
  try {
    m.counts = m.counts || {};
    // a run that stopped in the middle of a page is retried with a smaller page
    const pos = m.i + "|" + (m.t || "");
    if (m.pos === pos && m.started) m.sz = Math.max(1, Math.floor((m.sz || MIG[m.i][1]) / 2));
    m.pos = pos; m.started = 1;
    await migSave(ctx, m).run();
    const [col, def] = MIG[m.i];
    let path = `${col}?pageSize=${m.sz || def}` + (m.t ? `&pageToken=${encodeURIComponent(m.t)}` : "");
    if (col === "topups") path += TOPUP_FIELDS.map(f => "&mask.fieldPaths=" + f).join("");
    const r = await fsFetch(ctx, path);
    if (!r.ok) {
      m.started = 0; m.err = r.status === 429 ? "quota" : "http " + r.status;
      await migSave(ctx, m).run();
      return m;
    }
    const j = await r.json();
    const docs = j.documents || [];
    const st = docs.length ? await importStmts(ctx, col, docs) : [];
    m.n = (m.n || 0) + docs.length; m.counts[col] = (m.counts[col] || 0) + docs.length;
    m.err = ""; m.started = 0;
    if (j.nextPageToken) m.t = j.nextPageToken; else { m.i++; m.t = ""; m.sz = 0; }
    if (m.i >= MIG.length) { m.done = true; m.at = Date.now(); }
    // the page and the progress are saved together, so a page is never applied twice
    st.push(migSave(ctx, m), pubDirty(ctx));
    await ctx.db.batch(st);
    return m;
  } finally {
    await ctx.db.prepare("DELETE FROM meta WHERE k = 'miglock' AND v = ?1").bind(lock).run();
  }
}
async function importStmts(ctx, col, docs) {
  const t = Date.now();
  const items = docs.map(d => {
    const id = d.name.split("/").pop(), data = decodeFields(d.fields || {}, true);
    return { id, data, created: Number(data.createdAt) || Date.parse(d.createTime) || t };
  });
  const st = [];
  if (col === "users") {
    // accounts opened after the move keep what they did since; old balances are added on top
    const ex = (await ctx.db.prepare("SELECT id, data FROM docs WHERE col = 'users' AND id IN (SELECT value FROM json_each(?1))").bind(JSON.stringify(items.map(x => x.id))).all()).results || [];
    const map = new Map(ex.map(x => [x.id, JSON.parse(x.data)]));
    for (const it of items) {
      const d = it.data;
      d.wallets = d.wallets && typeof d.wallets === "object" ? d.wallets : {};
      const now = map.get(it.id);
      if (now && now._m) continue;            // already moved before: never add the old balance twice
      d._m = 1;
      if (now) {
        for (const [k, v] of Object.entries(now.wallets || {})) d.wallets[k] = (Number(d.wallets[k]) || 0) + (Number(v) || 0);
        if (now.defWallet) d.defWallet = now.defWallet;
      }
      st.push(putS(ctx, "users", it.id, d, it.created));
    }
  } else {
    for (const it of items)
      st.push(ctx.db.prepare("INSERT OR IGNORE INTO docs (col, id, uid, data, v, created, updated, del) VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6, 0)")
        .bind(col, it.id, uidOf(col, it.id, it.data), JSON.stringify(col === "topups" ? { ...it.data, hasShot: true } : it.data), it.created, t));
  }
  return st;
}
// progress page (no private data): opening it also pushes the move forward
const MIG_AR = { admins: "الإدارة", settings: "الإعدادات", users: "الحسابات والأرصدة", products: "المنتجات", categories: "الأقسام", banners: "البانرات", orders: "الطلبات", topups: "طلبات الشحن", tickets: "التذاكر" };
async function statusPage(ctx) {
  let m = await migState(ctx);
  if (!m.done) { try { m = await migrateStep(ctx); } catch (e) { console.error(e); } }
  const rows = MIG.map(([c], i) => `<tr><td>${MIG_AR[c]}</td><td>${(m.counts || {})[c] || 0}</td><td>${m.done || i < m.i ? "✅" : i === m.i ? "⏳" : "—"}</td></tr>`).join("");
  const msg = m.done ? "✅ تم نقل كل البيانات. الموقع شغّال على القاعدة الجديدة."
    : !ctx.env.FIREBASE_SA ? "⚠️ مفتاح القاعدة القديمة مش مضبوط."
    : m.err === "quota" ? "⏳ القاعدة القديمة مقفولة لين يتجدد العداد اليومي (حوالي 9 الصبح). النقل يبدا بروحه أول ما تفتح."
    : "⏳ جاري النقل... خلّي الصفحة مفتوحة يكمّل أسرع.";
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${m.done ? "" : `<meta http-equiv="refresh" content="${m.err === "quota" ? 30 : 2}">`}<title>نقل البيانات</title>
<style>body{font-family:system-ui,sans-serif;background:#0b1220;color:#e6edf7;margin:0;padding:24px 16px}main{max-width:460px;margin:auto}table{width:100%;border-collapse:collapse;margin-top:14px}td{padding:10px;border-bottom:1px solid #22304a}td:nth-child(2){text-align:center}.b{padding:14px;border-radius:12px;background:#15233d;line-height:1.8}</style></head>
<body><main><h2>نقل البيانات</h2><div class="b">${msg}</div><table>${rows}</table><p style="color:#8aa0c0;font-size:13px">المجموع: ${m.n || 0}</p></main></body></html>`;
}

/* ================= old database access (moving data, old receipts, push) ================= */
async function gToken(ctx) {
  const sa = JSON.parse(ctx.env.FIREBASE_SA);
  return { sa, at: await accessToken(sa) };
}
async function fsFetch(ctx, path, init = {}) {
  const { sa, at } = await gToken(ctx);
  return fetch(`https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/${path}`, { ...init, headers: { Authorization: `Bearer ${at}`, "Content-Type": "application/json" } });
}
function decodeValue(v, ms) {
  if (!v || typeof v !== "object") return null;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return Number(v.doubleValue);
  if ("booleanValue" in v) return v.booleanValue;
  if ("timestampValue" in v) return ms ? Date.parse(v.timestampValue) : v.timestampValue;
  if ("nullValue" in v) return null;
  if ("mapValue" in v) return decodeFields(v.mapValue.fields || {}, ms);
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(x => decodeValue(x, ms));
  return null;
}
function decodeFields(f, ms) { const o = {}; for (const k in f) o[k] = decodeValue(f[k], ms); return o; }

/* ================= supplier API ================= */
async function lp(ctx, method, path, { query, form, json } = {}) {
  const url = new URL(LP + path);
  if (query) for (const k in query) if (query[k] !== undefined && query[k] !== "") url.searchParams.set(k, query[k]);
  const headers = { "x-api-key": ctx.env.LP_KEY || "", "x-email": ctx.env.LP_EMAIL || "", Accept: "application/json" };
  let body;
  if (form) { headers["Content-Type"] = "application/x-www-form-urlencoded"; body = new URLSearchParams(form).toString(); }
  if (json) { headers["Content-Type"] = "application/json"; body = JSON.stringify(json); }
  const r = await fetch(url, { method, headers, body });
  let data = null; const txt = await r.text();
  try { data = JSON.parse(txt); } catch { data = { raw: txt.slice(0, 300) }; }
  return { ok: r.ok, status: r.status, data };
}
const lpMsg = (r) => {
  const m = (typeof r.data?.data === "string" ? r.data.data : "") || r.data?.message || r.data?.error || r.data?.msg || (r.data?.errors && JSON.stringify(r.data.errors)) || "";
  if (r.status === 400) return "رصيد المزوّد غير كافي";
  if (r.status === 401) return "مفاتيح المزوّد غير صحيحة";
  if (r.status === 422) return "المنتج غير موجود عند المزوّد أو بيانات ناقصة" + (m ? ` (${String(m).slice(0, 120)})` : "");
  return `خطأ من المزوّد (${r.status})` + (m ? `: ${String(m).slice(0, 120)}` : "");
};
function normProduct(p) {
  const fields = Array.isArray(p.params) ? p.params : (Array.isArray(p.likecard_option_feilds) ? p.likecard_option_feilds : []);
  let key = "", label = "";
  const obj = fields.find(f => f && typeof f === "object" && f.key && String(f.required ?? "1") === "1") || fields.find(f => f && typeof f === "object" && f.key);
  if (obj) { key = obj.key; label = obj.label || obj.name || obj.hint || ""; }
  else if (fields.length && typeof fields[0] === "string") { key = p.validation_field || "player_id"; label = fields[0]; }
  const nreq = fields.filter(f => f && typeof f === "object" && f.key && String(f.required ?? "1") === "1").length;
  const digital = p.pro_type === "digt" || (!!p.likecard_option_feilds && !p.params);
  const ptype = String(p.product_type || "").toLowerCase();
  return {
    id: String(p.id), name: p.name || "", image: p.image || p.photo || "",
    price: [p.selling_price, p.final_price, p.price, p.fixed_price, p.original_price].map(Number).find(v => isFinite(v) && v > 0) || 0, cur: p.currency_sign || p.currency_code || "",
    type: digital ? "digital" : "social", key, label,
    amount: !digital && (ptype === "amount" || !!(p.qty_values && p.qty_values.min && Number(p.qty_values.min) > 1)),
    available: p.available !== false,
    multi: nreq > 1
  };
}
async function supTree(ctx) {
  const r = await lp(ctx, "GET", "/digital-products/clone");
  const arr = Array.isArray(r.data) ? r.data : (Array.isArray(r.data?.data) ? r.data.data : []);
  return arr.map(c => ({
    id: String(c.id), name: c.name || "", image: c.image || c.photo || "",
    products: (c.products || []).map(normProduct),
    subs: (c.subCategories || c.sub_categories || []).map(sc => ({
      id: String(sc.id), name: sc.name || "", image: sc.image || sc.photo || "",
      products: (sc.products || []).map(normProduct)
    })).filter(sc => sc.products.length)
  })).filter(c => c.products.length || c.subs.length);
}
// the supplier's own record for one product (to check a link)
async function supProbe(ctx, sid) {
  const r = await lp(ctx, "GET", "/digital-products/clone");
  const arr = Array.isArray(r.data) ? r.data : (Array.isArray(r.data?.data) ? r.data.data : []);
  for (const c of arr) {
    const subs = c.subCategories || c.sub_categories || [];
    for (const [where, list] of [[c.name, c.products || []], ...subs.map(sc => [c.name + " › " + sc.name, sc.products || []])]) {
      const p = list.find(x => String(x.id) === sid);
      if (p) return { found: true, where, norm: normProduct(p), raw: JSON.stringify(p).slice(0, 3000) };
    }
  }
  return { found: false, http: r.status };
}
async function supProbeByName(ctx, link) {
  const f = findByName(await supTree(ctx), link);
  return { match: f.match || null, list: (f.list || []).slice(0, 5) };
}
function flattenTree(tree) {
  const out = [];
  tree.forEach(c => { c.products.forEach(p => out.push(p)); c.subs.forEach(sc => sc.products.forEach(p => out.push(p))); });
  return out;
}

/* ================= new order / top-up ================= */
async function onNew(ctx, type, id) {
  const doc = await getD(ctx, type, id);
  if (!doc) return { skip: "missing" };
  const d = doc.data;
  if (d.status !== "pending") return { skip: "done" };
  const created = Number(d.createdAt) || doc.created || 0;
  const first = !d.notified;
  if (Date.now() - created > (first ? 10 : 30) * 60 * 1000) return { skip: "old" };
  if (first && !(await patchD(ctx, type, id, { notified: true }, doc.v))) return { skip: "race" };

  // orders linked to the supplier are executed automatically
  let exec = null;
  if (type === "orders" && !d.sup) {
    const st = await settingsOf(ctx);
    if (st.supplier?.enabled) exec = await execOrder(ctx, id, false, st.supplier);
  }
  if (!first) return { exec };

  // the admin is only alerted when a human is needed
  const money = (c, cur) => `${(Number(c || 0) / 100).toFixed(2)} ${cur || "د.ل"}`;
  if (type === "orders" && exec && (exec.state === "done" || exec.state === "sent")) return { sent: 0, exec };
  let title = type === "orders" ? "🛒 طلب شراء جديد" : "💰 طلب شحن جديد";
  if (exec?.state === "refunded") title = exec.hidden ? "↩️ منتج غير متوفر عند المزوّد — رجعنا المبلغ وخفينا الباقة" : "↩️ المزوّد رفض الطلب — رجعنا المبلغ للزبون";
  else if (exec?.state === "failed") title = "⚠️ طلب يحتاج تدخل";
  else if (exec?.state === "test") title = "🧪 طلب تجريبي (ما اتنفذش)";
  const body = type === "orders"
    ? `${d.uName || ""} — ${d.productName || ""} ${d.optionLabel || ""} — ${money(d.price, d.cur)}${exec?.err ? " — " + exec.err : ""}`
    : `${d.uName || ""} — محفظة ${d.methodName || ""} — ${money(d.amount, d.cur)}`;
  const sent = await pushAll(ctx, title, body, (type === "orders" ? "o" : "t") + id);
  return { sent, exec };
}
async function pushAll(ctx, title, body, tag) {
  if (!ctx.env.FIREBASE_SA) return 0;
  const rows = (await ctx.db.prepare("SELECT id, data FROM docs WHERE col = 'adminTokens' AND del = 0 LIMIT 50").all()).results || [];
  if (!rows.length) return 0;
  const { sa, at } = await gToken(ctx);
  let sent = 0;
  await Promise.all(rows.map(async row => {
    const token = JSON.parse(row.data).token || row.id; if (!token) return;
    const s = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
      method: "POST", headers: { Authorization: `Bearer ${at}`, "Content-Type": "application/json" },
      body: JSON.stringify({ message: { token, webpush: {
        headers: { Urgency: "high", TTL: "86400" },
        notification: { title, body, icon: `${ctx.site}/img/icon-192.png`, badge: `${ctx.site}/img/icon-192.png`, dir: "rtl", lang: "ar", tag, renotify: true },
        fcm_options: { link: `${ctx.site}/admin.html` } } } })
    });
    if (s.ok) sent++;
    else if (s.status === 404 || s.status === 400) await ctx.db.prepare("DELETE FROM docs WHERE col = 'adminTokens' AND id = ?1").bind(row.id).run();
  }));
  return sent;
}

/* ================= execute an order at the supplier ================= */
async function execOrder(ctx, id, manual, supSettings) {
  const path = ["orders", id];
  const doc = await getD(ctx, "orders", id);
  if (!doc) return { state: "skip", err: "الطلب غير موجود" };
  const o = doc.data;
  if (o.status !== "pending") return { state: "skip", err: "الطلب مش قيد التنفيذ" };
  if (o.sup && ["sending", "sent", "done"].includes(o.sup.state)) return { state: "skip", err: "الطلب أُرسل للمزوّد قبل" };

  const sup = supSettings || (await settingsOf(ctx)).supplier || {};
  if (!sup.enabled) return { state: "skip", err: "ربط المزوّد غير مفعّل" };
  const prod = await getD(ctx, "products", o.productId);
  const opt = prod?.data?.options?.[o.optionIndex];
  const link = opt?.sup;
  if (!link?.id) return { state: "skip", err: "الباقة مش مربوطة بمنتج عند المزوّد" };

  // lock the order so nothing executes it twice
  const uuid = crypto.randomUUID();
  const sandbox = !!sup.sandbox;
  const set = obj => patchD(ctx, ...path, obj);
  if (!(await patchD(ctx, ...path, { sup: { state: "sending", id: link.id, type: link.type || "", uuid, sandbox, at: Date.now() } }, doc.v)))
    return { state: "skip", err: "الطلب قيد المعالجة" };

  const input = String(o.input || "");
  const fake = v => /^[xX*\-\s]+$/.test(String(v || ""));
  const testDone = async (type, L = link) => { await set({ sup: { state: "test", id: L.id, type, uuid, sandbox: true, err: "🧪 تجربة ناجحة — الطلب ما اتنفذش فعلياً (وضع التجربة)", at: Date.now() } }); return { state: "test" }; };
  const sendOnce = async (link) => {
  let r;
  if (link.type === "digital") {
    const payload = { productID: link.id, env: sandbox ? "sandbox" : "production" };
    if (input && link.key) payload.optionalFields = { [link.key]: input };
    r = await lpSafe(ctx, "POST", "/digital-products/payment", { json: payload });
    const d = r.data?.data;
    if (r.ok && r.data?.status !== false && d && (sandbox || fake(d.secretNumber))) return { result: await testDone("digital", link) };
    if (r.ok && r.data?.status !== false && d) {
      // some products return only an order reference ("order-<id>") and deliver the code later
      const isRef = v => /^order[-_]/i.test(String(v || "").trim());
      const refOf = v => String(v || "").trim().replace(/^order[-_]/i, "");
      const codes = (Array.isArray(d.items) && d.items.length ? d.items : [d]).filter(c => c && c.secretNumber && !isRef(c.secretNumber));
      const ref = String(d.order_id ?? "") || [d.serialNumber, d.secretNumber].filter(isRef).map(refOf)[0] || "";
      if (codes.length) {
        const lines = codes.map(c => String(c.secretNumber).trim()).filter(Boolean);
        await set({ status: "done", delivery: lines.join("\n"), sup: { state: "done", id: link.id, type: "digital", uuid, ref, at: Date.now() }, updatedAt: Date.now() });
        return { result: { state: "done" } };
      }
      await set({ status: "processing", sup: { state: "sent", id: link.id, type: "digital", uuid, ref, at: Date.now() }, updatedAt: Date.now() });
      return { result: { state: "sent" } };
    }
  } else {
    const params = {};
    if (link.key) params[link.key] = input;
    const payload = { product_id: link.id, qty: 1, params, order_uuid: uuid, env: sandbox ? "sandbox" : "production" };
    r = await lpSafe(ctx, "POST", "/social/pay", { json: payload });
    const d = r.data?.data;
    if (r.ok && r.data?.status !== false && d && sandbox) return { result: await testDone("social", link) };
    if (r.ok && r.data?.status !== false && d) {
      const ref = String(d.order_id ?? d.id ?? "");
      await set({ status: "processing", sup: { state: "sent", id: link.id, type: "social", uuid, ref, ext: String(d.external_id ?? ""), at: Date.now() }, updatedAt: Date.now() });
      return { result: { state: "sent" } };
    }
  }
  return { r };
  };
  // if the supplier refuses because the product got a new number on their side, find it by name and try once more
  let L = link, r;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await sendOnce(L);
    if (res.result) return res.result;
    r = res.r;
    if (attempt === 0 && failKind(r) === "reject") {
      const nl = await relinkServer(ctx, o.productId, o.optionIndex, L).catch(e => (console.error(e), null));
      if (nl) { L = nl; continue; }
    }
    break;
  }
  // what went wrong decides what happens next
  const err = r.lost ? "انقطع الاتصال بالمزوّد — راجع حسابك عند المزوّد قبل ما تعاود الإرسال" : lpMsg(r);
  const raw = r.lost ? "" : JSON.stringify(r.data ?? "").slice(0, 400);
  const kind = failKind(r);
  const supFail = { state: "failed", id: L.id, type: L.type || "", uuid, err, raw, http: r.status || 0, kind, at: Date.now() };
  const na = kind === "reject" && unavailableMsg(r);
  if (na) await markOff(ctx, o.productId, o.optionIndex, "fail");
  // the supplier refused the order (nothing was charged there): give the customer the money back right away
  if (kind === "reject" && !manual) {
    const note = na ? "المنتج غير متوفر حالياً عند المورد، رجعنا المبلغ لمحفظتك" : "تعذر تنفيذ الطلب" + (/id|player|user|معرف|الآيدي/i.test(supMessage(r)) ? " — تأكد من البيانات المدخلة" : "") + "، رجعنا المبلغ لمحفظتك";
    if (await refundCore(ctx, id, note, { sup: { ...supFail, state: "refunded" } })) return { state: "refunded", err, hidden: na };
  }
  await set({ sup: supFail });
  return { state: "failed", err, hidden: na };
}
// supplier product names compared loosely (spaces, dashes, Arabic letter forms)
const nameKey = t => String(t || "").toLowerCase().replace(/[أإآ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي").replace(/[\s\-_–—.,:()/]+/g, "").trim();
function findByName(tree, link) {
  const all = flattenTree(tree);
  if (all.some(x => x.id === String(link.id))) return { same: true };
  const k = nameKey(link.name);
  let c = all.filter(x => k && nameKey(x.name) === k && x.available);
  if (link.type) { const t = c.filter(x => x.type === link.type); if (t.length) c = t; }
  if (c.length > 1 && link.cost > 0) {
    c.sort((a, b) => Math.abs(a.price - link.cost) - Math.abs(b.price - link.cost));
    if (Math.abs(c[0].price - link.cost) === Math.abs(c[1].price - link.cost)) return { ambiguous: true, list: c };
    c = [c[0]];
  }
  if (c.length !== 1) return { list: c };
  return { match: c[0] };
}
async function relinkServer(ctx, pid, idx, link) {
  if (!link?.name) return null;
  const f = findByName(await supTree(ctx), link);
  const x = f.match;
  if (!x) return null;
  // never sell at a loss: a much higher cost needs the admin to reprice first
  if (link.cost > 0 && (x.cur || "") === (link.cur || "") && x.price > link.cost * 1.15) return null;
  const nl = { ...link, id: x.id, type: x.type, key: x.key || link.key || "", name: x.name, cost: x.price, cur: x.cur, relinkedAt: Date.now(), oldId: String(link.id) };
  for (let i = 0; i < 3; i++) {
    const p = await getD(ctx, "products", pid);
    if (!p?.data?.options?.[idx]) return null;
    const options = p.data.options.map((o, j) => { if (j !== idx) return o; const { off, offBy, offAt, ...rest } = o; return { ...rest, sup: nl }; });
    const res = await ctx.db.batch([updS(ctx, "products", pid, { ...p.data, options }, p.v), pubDirty(ctx)]);
    if (res[0].meta.changes === 1) return nl;
  }
  return null;
}
async function lpSafe(ctx, method, path, opts) {
  try { return await lp(ctx, method, path, opts); }
  catch (e) { return { ok: false, status: 0, data: null, lost: true }; }
}
const supMessage = r => String((typeof r.data?.data === "string" ? r.data.data : "") || r.data?.message || r.data?.error || r.data?.msg || (r.data?.errors ? JSON.stringify(r.data.errors) : "") || "");
// temp = try again later, balance/keys = admin must act, reject = the supplier refused this order
function failKind(r) {
  if (r.lost || !r.status || r.status >= 500 || r.status === 429) return "temp";
  if (r.status === 401 || r.status === 403) return "keys";
  const m = supMessage(r);
  if (/balance|insufficient|fund|credit|رصيد/i.test(m)) return "balance";
  if (r.status === 400 && !unavailableMsg(r)) return "balance";
  return "reject";
}
const unavailableMsg = r => /not\s*available|unavailable|out\s*of\s*stock|no\s*stock|sold\s*out|غير\s*(متوفر|متاح)|نف[ذد]ت?\s*(الكمية|الكميه)?/i.test(supMessage(r));
// hide one package from the store (it comes back when the supplier lists it as available again)
async function markOff(ctx, pid, idx, by) {
  for (let i = 0; i < 3; i++) {
    const p = await getD(ctx, "products", pid);
    const opt = p?.data?.options?.[idx];
    if (!opt || opt.off) return;
    const options = p.data.options.map((x, j) => j === idx ? { ...x, off: true, offBy: by, offAt: Date.now() } : x);
    const r = await ctx.db.batch([updS(ctx, "products", pid, { ...p.data, options }, p.v), pubDirty(ctx)]);
    if (r[0].meta.changes === 1) return;
  }
}

/* ================= sync orders that are waiting at the supplier ================= */
const OK_ST = ["accept", "accepted", "complete", "completed", "done", "success", "successful", "delivered"];
const BAD_ST = ["reject", "rejected", "cancel", "canceled", "cancelled", "fail", "failed", "refund", "refunded", "error"];
async function syncOrders(ctx, ids, rateLimit) {
  let orders = [];
  if (ids) {
    for (const id of ids) { const d = await getD(ctx, "orders", id); if (d) orders.push(d); }
  } else {
    const rows = (await ctx.db.prepare("SELECT id, data, v FROM docs WHERE col = 'orders' AND del = 0 AND updated > ?1 AND json_extract(data, '$.status') = 'processing' LIMIT 60").bind(Date.now() - 3 * 86400000).all()).results || [];
    orders = rows.map(x => ({ id: x.id, v: x.v, data: JSON.parse(x.data) }));
  }
  orders = orders.filter(o => o.data.status === "processing" && o.data.sup?.state === "sent" && !o.data.sup?.sandbox);
  if (rateLimit) orders = orders.filter(o => Date.now() - (Number(o.data.sup.checkedAt) || Date.parse(o.data.sup.checkedAt || 0) || 0) > 20000);
  if (!orders.length) return { checked: 0, updated: 0 };

  const seen = new Map();
  const norm = k => String(k).trim().toLowerCase().replace(/^order[-_]/, "");
  const add = (x) => { if (!x) return; for (const k of [x.id, x.catalog_order_id, x.order_id, x.order_uuid, x.external_id]) if (k !== undefined && k !== null && k !== "") seen.set(norm(k), x); };
  const a = await lp(ctx, "GET", "/social/order-and-status");
  (Array.isArray(a.data?.data) ? a.data.data : []).forEach(add);
  const b = await lp(ctx, "GET", "/social/orders", { query: { per_page: 100 } });
  (Array.isArray(b.data?.data?.data) ? b.data.data.data : []).forEach(x => { if (!seen.has(norm(x.id))) add(x); });

  let updated = 0;
  for (const o of orders) {
    const s = o.data.sup;
    const m = [s.ref, s.uuid, s.ext].filter(Boolean).map(norm).map(k => seen.get(k)).find(Boolean);
    const st = String(m?.status || "").toLowerCase();
    const set = obj => patchD(ctx, "orders", o.id, obj);
    const now = Date.now();
    if (m && OK_ST.includes(st) && /^[xX*\-\s]+$/.test(String(m.delivery_data || ""))) {
      await set({ sup: { ...s, state: "failed", err: "المزوّد رجّع كود تجريبي — راجع الطلب", checkedAt: now } }); updated++;
    } else if (m && OK_ST.includes(st) && s.type === "digital" && !deliveryText(m)) {
      await set({ sup: { ...s, checkedAt: now } });
    } else if (m && OK_ST.includes(st)) {
      await set({ status: "done", delivery: deliveryText(m) || "تم التنفيذ ✓", sup: { ...s, state: "done", checkedAt: now }, updatedAt: now }); updated++;
    } else if (m && BAD_ST.includes(st)) {
      await set({ sup: { ...s, state: "failed", err: "المزوّد رفض الطلب — ألغه من اللوحة لإرجاع المبلغ للزبون", checkedAt: now } }); updated++;
    } else {
      await set({ sup: { ...s, checkedAt: now } });
    }
  }
  return { checked: orders.length, updated };
}
function deliveryText(m) {
  const v = m.delivery_data ?? m.code ?? m.codes ?? null;
  if (!v) return "";
  const one = c => typeof c === "string" ? c : String(c.secretNumber || c.code || c.pin || "");
  let t = Array.isArray(v) ? v.map(one).join("\n") : typeof v === "object" ? one(v) : String(v);
  if (typeof v === "string") { try { const j = JSON.parse(v); if (j && typeof j === "object") t = Array.isArray(j) ? j.map(one).join("\n") : one(j); } catch {} }
  return /^order[-_]/i.test(t.trim()) ? "" : t.trim();
}

/* ================= background jobs (every minute) ================= */
async function supplierJobs(ctx) {
  const st = await settingsOf(ctx);
  if (!st.supplier?.enabled) return;
  const rows = (await ctx.db.prepare("SELECT id, data, created FROM docs WHERE col = 'orders' AND del = 0 AND updated > ?1 AND json_extract(data, '$.status') IN ('pending', 'processing') LIMIT 80").bind(Date.now() - 86400000).all()).results || [];
  const now = Date.now();
  const list = rows.map(r => ({ id: r.id, created: r.created, data: JSON.parse(r.data) }));
  // safety net: linked orders that were never sent (e.g. the first attempt was interrupted)
  const waiting = list.filter(o => o.data.status === "pending" && !o.data.sup && now - (Number(o.data.createdAt) || o.created) > 20000 && now - (Number(o.data.createdAt) || o.created) < 30 * 60 * 1000).slice(0, 3);
  for (const o of waiting) await execOrder(ctx, o.id, false, st.supplier);
  // an attempt that never got an answer (connection dropped): show it to the admin instead of leaving it hanging
  for (const o of list.filter(o => o.data.status === "pending" && o.data.sup?.state === "sending" && now - (Number(o.data.sup.at) || 0) > 3 * 60 * 1000).slice(0, 5))
    await patchD(ctx, "orders", o.id, { sup: { ...o.data.sup, state: "failed", kind: "temp", err: "انقطع الاتصال بالمزوّد — راجع حسابك عند المزوّد قبل ما تعاود الإرسال" } });
  if (list.some(o => o.data.status === "processing" && o.data.sup?.state === "sent")) await syncOrders(ctx, null, false);
}

/* ================= google service-account token ================= */
async function accessToken(sa) {
  if (cached.token && Date.now() < cached.exp) return cached.token;
  const now = Math.floor(Date.now() / 1000);
  const enc = o => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = enc({ alg: "RS256", typ: "JWT" }) + "." + enc({
    iss: sa.client_email, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
    scope: "https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/firebase.messaging"
  });
  const pem = sa.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const key = await crypto.subtle.importKey("pkcs8", Uint8Array.from(atob(pem), c => c.charCodeAt(0)),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=" + unsigned + "." + b64url(new Uint8Array(sig))
  });
  const j = await r.json();
  if (!j.access_token) throw new Error("auth failed");
  cached = { token: j.access_token, exp: Date.now() + 50 * 60 * 1000 };
  return j.access_token;
}
function b64url(bytes) { let s = ""; bytes.forEach(b => s += String.fromCharCode(b)); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
