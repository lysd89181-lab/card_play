// Cloudflare Worker for Card Play:
//  - admin push notifications for new orders / top-ups
//  - supplier (Libya Play) integration: product list, balance, automatic order execution, status sync
// Secrets (Cloudflare dashboard): FIREBASE_SA (service-account JSON), LP_KEY (supplier api key), LP_EMAIL (supplier account email)
// Var (wrangler.jsonc): FB_API_KEY (public web api key, used to verify admin sign-in tokens)

const LP = "https://api.libyaplay.com/portal";
let cached = { token: "", exp: 0 };

export default {
  async fetch(req, env) {
    const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
    const json = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { ...cors, "Content-Type": "application/json" } });
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    if (req.method !== "POST") return json({ ok: true, service: "cardplay" });
    try {
      const body = JSON.parse(await req.text() || "{}");
      const ctx = await makeCtx(env, req);

      // ---------- public: ping after a new order / top-up ----------
      if (!body.action) {
        const { type, id } = body;
        if (!["orders", "topups"].includes(type) || !validId(id)) return json({ ok: false }, 400);
        const res = await onNew(ctx, type, id);
        return json({ ok: true, ...res });
      }

      // ---------- public: customer page asks for a status refresh of one of its orders ----------
      if (body.action === "sup_check") {
        if (!validId(body.id)) return json({ ok: false }, 400);
        return json({ ok: true, ...(await syncOrders(ctx, [body.id], true)) });
      }

      // ---------- admin-only ----------
      const who = await adminFromToken(ctx, body.idToken);
      if (!who) return json({ ok: false, error: "unauthorized" }, 401);

      if (body.action === "sup_products") {
        if (!who.can("products")) return json({ ok: false, error: "forbidden" }, 403);
        const tree = await supTree(ctx);
        return json({ ok: true, products: flattenTree(tree) });
      }
      if (body.action === "sup_tree") {
        if (!who.can("products")) return json({ ok: false, error: "forbidden" }, 403);
        return json({ ok: true, tree: await supTree(ctx) });
      }
      if (body.action === "sup_balance") {
        if (!who.can("settings") && !who.can("products")) return json({ ok: false, error: "forbidden" }, 403);
        const r = await lp(ctx, "GET", "/general/profile");
        const d = r.data?.data || {};
        return json({ ok: r.ok, status: r.status, balance: d.wallet ?? null, currency: d.currency_code || "", name: d.name || "" });
      }
      if (body.action === "sup_exec") {
        if (!who.can("orders")) return json({ ok: false, error: "forbidden" }, 403);
        if (!validId(body.id)) return json({ ok: false }, 400);
        return json({ ok: true, ...(await execOrder(ctx, body.id, true)) });
      }
      if (body.action === "sup_sync") {
        if (!who.can("orders")) return json({ ok: false, error: "forbidden" }, 403);
        return json({ ok: true, ...(await syncOrders(ctx, null, false)) });
      }
      return json({ ok: false, error: "unknown action" }, 400);
    } catch (e) {
      return json({ ok: false, error: String(e && e.message || e) }, 500);
    }
  }
};

const validId = id => /^[A-Za-z0-9]{10,40}$/.test(id || "");

/* ================= context / firestore helpers ================= */
async function makeCtx(env, req) {
  const sa = JSON.parse(env.FIREBASE_SA);
  const at = await accessToken(sa);
  return {
    env, sa,
    H: { Authorization: `Bearer ${at}`, "Content-Type": "application/json" },
    base: `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents`,
    site: (req.headers.get("Origin") || "https://cardplay.com.ly").replace(/\/+$/, "")
  };
}
async function getDoc(ctx, path) {
  const r = await fetch(`${ctx.base}/${path}`, { headers: ctx.H });
  if (!r.ok) return null;
  const d = await r.json();
  return { name: d.name, updateTime: d.updateTime, createTime: d.createTime, data: decodeFields(d.fields || {}) };
}
// PATCH selected top-level fields; returns true on success. precondition = updateTime string (optional)
async function patchDoc(ctx, path, obj, precondition) {
  const mask = Object.keys(obj).map(k => "updateMask.fieldPaths=" + encodeURIComponent(k)).join("&");
  const pre = precondition ? `&currentDocument.updateTime=${encodeURIComponent(precondition)}` : "";
  const r = await fetch(`${ctx.base}/${path}?${mask}${pre}`, { method: "PATCH", headers: ctx.H, body: JSON.stringify({ fields: encodeFields(obj) }) });
  return r.ok;
}
function decodeValue(v) {
  if (!v || typeof v !== "object") return null;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return Number(v.doubleValue);
  if ("booleanValue" in v) return v.booleanValue;
  if ("timestampValue" in v) return v.timestampValue;
  if ("nullValue" in v) return null;
  if ("mapValue" in v) return decodeFields(v.mapValue.fields || {});
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(decodeValue);
  return null;
}
function decodeFields(f) { const o = {}; for (const k in f) o[k] = decodeValue(f[k]); return o; }
function encodeValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === "string") return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encodeValue) } };
  return { mapValue: { fields: encodeFields(v) } };
}
function encodeFields(o) { const f = {}; for (const k in o) f[k] = encodeValue(o[k]); return f; }

/* ================= admin auth ================= */
async function adminFromToken(ctx, idToken) {
  if (!idToken || !ctx.env.FB_API_KEY) return null;
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${ctx.env.FB_API_KEY}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken }) });
  if (!r.ok) return null;
  const uid = (await r.json()).users?.[0]?.localId;
  if (!uid) return null;
  const a = await getDoc(ctx, `admins/${uid}`);
  if (!a) return null;
  const owner = a.data.role !== "staff";
  const perms = Array.isArray(a.data.perms) ? a.data.perms : ["orders", "topups", "tickets"];
  return { uid, owner, can: p => owner || perms.includes(p) };
}

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

// full catalogue as a tree: root categories -> sub categories -> products (digital codes + masar top-ups)
function normProduct(p) {
  const fields = Array.isArray(p.params) ? p.params : (Array.isArray(p.likecard_option_feilds) ? p.likecard_option_feilds : []);
  let key = "", label = "";
  const obj = fields.find(f => f && typeof f === "object" && f.key && String(f.required ?? "1") === "1") || fields.find(f => f && typeof f === "object" && f.key);
  if (obj) { key = obj.key; label = obj.label || obj.name || obj.hint || ""; }
  else if (fields.length && typeof fields[0] === "string") { key = p.validation_field || "player_id"; label = fields[0]; }
  const digital = p.pro_type === "digt" || (!!p.likecard_option_feilds && !p.params);
  const ptype = String(p.product_type || "").toLowerCase();
  return {
    id: String(p.id), name: p.name || "", image: p.image || p.photo || "",
    price: [p.selling_price, p.final_price, p.price, p.fixed_price, p.original_price].map(Number).find(v => isFinite(v) && v > 0) || 0, cur: p.currency_sign || p.currency_code || "",
    type: digital ? "digital" : "social", key, label,
    amount: !digital && (ptype === "amount" || !!(p.qty_values && p.qty_values.min && Number(p.qty_values.min) > 1)),
    available: p.available !== false
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
function flattenTree(tree) {
  const out = [];
  tree.forEach(c => { c.products.forEach(p => out.push(p)); c.subs.forEach(sc => sc.products.forEach(p => out.push(p))); });
  return out;
}

/* ================= new order / top-up ================= */
async function onNew(ctx, type, id) {
  const doc = await getDoc(ctx, `${type}/${id}`);
  if (!doc) return { skip: "missing" };
  const d = doc.data;
  if (d.status !== "pending" || d.notified) return { skip: "done" };
  const created = Date.parse(d.createdAt || doc.createTime || 0);
  if (Date.now() - created > 10 * 60 * 1000) return { skip: "old" };
  if (!(await patchDoc(ctx, `${type}/${id}`, { notified: true }, doc.updateTime))) return { skip: "race" };

  let sent = 0, exec = null;
  if (type === "orders") {
    const st = await getDoc(ctx, "settings/app");
    if (st?.data?.supplier?.enabled && st.data.supplier.auto) exec = await execOrder(ctx, id, false, st.data.supplier);
  }
  // push to admins (the order title reflects the supplier result when it ran)
  const money = (c, cur) => `${(Number(c || 0) / 100).toFixed(2)} ${cur || "د.ل"}`;
  let title = type === "orders" ? "🛒 طلب شراء جديد" : "💰 طلب شحن جديد";
  if (exec?.state === "done") title = "✅ طلب نُفّذ تلقائياً";
  else if (exec?.state === "sent") title = "⏳ طلب أُرسل للمزوّد";
  else if (exec?.state === "failed") title = "⚠️ طلب يحتاج تدخل";
  else if (exec?.state === "test") title = "🧪 طلب تجريبي (ما اتنفذش)";
  const body = type === "orders"
    ? `${d.uName || ""} — ${d.productName || ""} ${d.optionLabel || ""} — ${money(d.price, d.cur)}${exec?.state === "failed" ? " — " + exec.err : ""}`
    : `${d.uName || ""} — محفظة ${d.methodName || ""} — ${money(d.amount, d.cur)}`;
  sent = await pushAll(ctx, title, body, (type === "orders" ? "o" : "t") + id);
  return { sent, exec };
}

async function pushAll(ctx, title, body, tag) {
  const lt = await fetch(`${ctx.base}/adminTokens?pageSize=100`, { headers: ctx.H });
  const docs = (await lt.json()).documents || [];
  let sent = 0;
  await Promise.all(docs.map(async td => {
    const token = td.fields?.token?.stringValue; if (!token) return;
    const s = await fetch(`https://fcm.googleapis.com/v1/projects/${ctx.sa.project_id}/messages:send`, {
      method: "POST", headers: ctx.H,
      body: JSON.stringify({ message: { token, webpush: {
        headers: { Urgency: "high", TTL: "86400" },
        notification: { title, body, icon: `${ctx.site}/img/icon-192.png`, badge: `${ctx.site}/img/icon-192.png`, dir: "rtl", lang: "ar", tag, renotify: true },
        fcm_options: { link: `${ctx.site}/admin.html` } } } })
    });
    if (s.ok) sent++;
    else if (s.status === 404 || s.status === 400) await fetch(`https://firestore.googleapis.com/v1/${td.name}`, { method: "DELETE", headers: ctx.H });
  }));
  return sent;
}

/* ================= execute an order at the supplier ================= */
async function execOrder(ctx, id, manual, supSettings) {
  const path = `orders/${id}`;
  const doc = await getDoc(ctx, path);
  if (!doc) return { state: "skip", err: "الطلب غير موجود" };
  const o = doc.data;
  if (o.status !== "pending") return { state: "skip", err: "الطلب مش قيد التنفيذ" };
  if (o.sup && ["sending", "sent", "done"].includes(o.sup.state)) return { state: "skip", err: "الطلب أُرسل للمزوّد قبل" };

  const sup = supSettings || (await getDoc(ctx, "settings/app"))?.data?.supplier || {};
  if (!sup.enabled) return { state: "skip", err: "ربط المزوّد غير مفعّل" };
  const prod = await getDoc(ctx, `products/${o.productId}`);
  const opt = prod?.data?.options?.[o.optionIndex];
  const link = opt?.sup;
  if (!link?.id) return { state: "skip", err: "الباقة مش مربوطة بمنتج عند المزوّد" };

  // lock the order so nothing executes it twice
  const uuid = crypto.randomUUID();
  const sandbox = !!sup.sandbox;
  if (!(await patchDoc(ctx, path, { sup: { state: "sending", id: link.id, type: link.type || "", uuid, sandbox, at: new Date() } }, doc.updateTime)))
    return { state: "skip", err: "الطلب قيد المعالجة" };

  const input = String(o.input || "");
  const fake = v => /^[xX*\-\s]+$/.test(String(v || ""));
  const testDone = async (type) => { await patchDoc(ctx, path, { sup: { state: "test", id: link.id, type, uuid, sandbox: true, err: "🧪 تجربة ناجحة — الطلب ما اتنفذش فعلياً (وضع التجربة)", at: new Date() } }); return { state: "test" }; };
  let r;
  if (link.type === "digital") {
    const payload = { productID: link.id, env: sandbox ? "sandbox" : "production" };
    if (input && link.key) payload.optionalFields = { [link.key]: input };
    r = await lp(ctx, "POST", "/digital-products/payment", { json: payload });
    const d = r.data?.data;
    if (r.ok && r.data?.status !== false && d && (sandbox || fake(d.secretNumber))) return await testDone("digital");
    if (r.ok && r.data?.status !== false && d) {
      // some products return only an order reference ("order-<id>") and deliver the code later
      const isRef = v => /^order[-_]/i.test(String(v || "").trim());
      const refOf = v => String(v || "").trim().replace(/^order[-_]/i, "");
      const codes = (Array.isArray(d.items) && d.items.length ? d.items : [d]).filter(c => c && c.secretNumber && !isRef(c.secretNumber));
      const ref = String(d.order_id ?? "") || [d.serialNumber, d.secretNumber].filter(isRef).map(refOf)[0] || "";
      if (codes.length) {
        const lines = codes.flatMap(c => [`${c.secretNumber}`, c.serialNumber && !isRef(c.serialNumber) && c.serialNumber !== c.secretNumber && `Serial: ${c.serialNumber}`, c.exp_date && `Exp: ${c.exp_date}`]).filter(Boolean);
        await patchDoc(ctx, path, { status: "done", delivery: lines.join("\n"), sup: { state: "done", id: link.id, type: "digital", uuid, ref, at: new Date() }, updatedAt: new Date() });
        return { state: "done" };
      }
      // accepted but code not ready yet -> wait and sync later
      await patchDoc(ctx, path, { status: "processing", sup: { state: "sent", id: link.id, type: "digital", uuid, ref, at: new Date() }, updatedAt: new Date() });
      return { state: "sent" };
    }
  } else {
    const params = {};
    if (link.key) params[link.key] = input;
    const payload = { product_id: link.id, qty: 1, params, order_uuid: uuid };
    payload.env = sandbox ? "sandbox" : "production";
    r = await lp(ctx, "POST", "/social/pay", { json: payload });
    const d = r.data?.data;
    if (r.ok && r.data?.status !== false && d && sandbox) return await testDone("social");
    if (r.ok && r.data?.status !== false && d) {
      const ref = String(d.order_id ?? d.id ?? "");
      await patchDoc(ctx, path, { status: "processing", sup: { state: "sent", id: link.id, type: "social", uuid, ref, ext: String(d.external_id ?? ""), at: new Date() }, updatedAt: new Date() });
      return { state: "sent" };
    }
  }
  const err = lpMsg(r);
  await patchDoc(ctx, path, { sup: { state: "failed", id: link.id, type: link.type || "", uuid, err, at: new Date() } });
  return { state: "failed", err };
}

/* ================= sync social orders that are waiting at the supplier ================= */
// supplier statuses: pending, wait, accept, reject
const OK_ST = ["accept", "accepted", "complete", "completed", "done", "success", "successful", "delivered"];
const BAD_ST = ["reject", "rejected", "cancel", "canceled", "cancelled", "fail", "failed", "refund", "refunded", "error"];
async function syncOrders(ctx, ids, rateLimit) {
  let orders = [];
  if (ids) {
    for (const id of ids) { const d = await getDoc(ctx, `orders/${id}`); if (d) orders.push({ id, ...d }); }
  } else {
    const q = await fetch(`${ctx.base}:runQuery`, { method: "POST", headers: ctx.H, body: JSON.stringify({ structuredQuery: {
      from: [{ collectionId: "orders" }], where: { fieldFilter: { field: { fieldPath: "status" }, op: "EQUAL", value: { stringValue: "processing" } } }, limit: 60 } }) });
    const rows = await q.json();
    orders = (Array.isArray(rows) ? rows : []).filter(x => x.document).map(x => ({ id: x.document.name.split("/").pop(), updateTime: x.document.updateTime, data: decodeFields(x.document.fields || {}) }));
  }
  orders = orders.filter(o => o.data.status === "processing" && o.data.sup?.state === "sent" && !o.data.sup?.sandbox);
  if (rateLimit) orders = orders.filter(o => Date.now() - Date.parse(o.data.sup.checkedAt || 0) > 20000);
  if (!orders.length) return { checked: 0, updated: 0 };

  // pull recent supplier orders (with delivery codes)
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
    const path = `orders/${o.id}`;
    if (m && OK_ST.includes(st) && /^[xX*\-\s]+$/.test(String(m.delivery_data || ""))) {
      await patchDoc(ctx, path, { sup: { ...s, state: "failed", err: "المزوّد رجّع كود تجريبي — راجع الطلب", checkedAt: new Date() } });
      updated++;
    } else if (m && OK_ST.includes(st) && s.type === "digital" && !deliveryText(m)) {
      await patchDoc(ctx, path, { sup: { ...s, checkedAt: new Date() } });   // accepted but code not visible yet
    } else if (m && OK_ST.includes(st)) {
      await patchDoc(ctx, path, { status: "done", delivery: deliveryText(m) || "تم التنفيذ ✓", sup: { ...s, state: "done", checkedAt: new Date() }, updatedAt: new Date() });
      updated++;
    } else if (m && BAD_ST.includes(st)) {
      await patchDoc(ctx, path, { sup: { ...s, state: "failed", err: "المزوّد رفض الطلب — ألغه من اللوحة لإرجاع المبلغ للزبون", checkedAt: new Date() } });
      updated++;
    } else {
      await patchDoc(ctx, path, { sup: { ...s, checkedAt: new Date() } });
    }
  }
  return { checked: orders.length, updated };
}

// delivery_data may be a string, an object with codes, or a list
function deliveryText(m) {
  const v = m.delivery_data ?? m.code ?? m.codes ?? null;
  if (!v) return "";
  const one = c => typeof c === "string" ? c : [c.secretNumber || c.code || c.pin, c.serialNumber && `Serial: ${c.serialNumber}`, (c.exp_date || c.expiry) && `Exp: ${c.exp_date || c.expiry}`].filter(Boolean).join("\n");
  let t = Array.isArray(v) ? v.map(one).join("\n") : typeof v === "object" ? one(v) : String(v);
  if (typeof v === "string") { try { const j = JSON.parse(v); if (j && typeof j === "object") t = Array.isArray(j) ? j.map(one).join("\n") : one(j); } catch {} }
  return /^order[-_]/i.test(t.trim()) ? "" : t.trim();
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
