// Cloudflare Worker: sends admin push notifications for new orders / top-ups.
// Secret required: FIREBASE_SA  (the full Firebase service-account JSON)
let cached = { token: "", exp: 0 };

export default {
  async fetch(req, env) {
    const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
    const json = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { ...cors, "Content-Type": "application/json" } });
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    if (req.method !== "POST") return json({ ok: true, service: "cardplay-notify" });
    try {
      const { type, id } = JSON.parse(await req.text() || "{}");
      if (!["orders", "topups"].includes(type) || !/^[A-Za-z0-9]{10,40}$/.test(id || "")) return json({ ok: false }, 400);

      const sa = JSON.parse(env.FIREBASE_SA);
      const at = await accessToken(sa);
      const H = { Authorization: `Bearer ${at}`, "Content-Type": "application/json" };
      const base = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents`;

      // 1) read the order / top-up and make sure it is new and not already notified
      const r = await fetch(`${base}/${type}/${id}`, { headers: H });
      if (!r.ok) return json({ ok: false }, 404);
      const d = await r.json(), f = d.fields || {};
      const S = k => f[k]?.stringValue ?? "";
      const N = k => Number(f[k]?.integerValue ?? f[k]?.doubleValue ?? 0);
      if (S("status") !== "pending" || f.notified?.booleanValue) return json({ ok: true, skip: "done" });
      const created = Date.parse(f.createdAt?.timestampValue || d.createTime || 0);
      if (Date.now() - created > 10 * 60 * 1000) return json({ ok: true, skip: "old" });

      // 2) mark as notified (only one request can win thanks to the updateTime precondition)
      const m = await fetch(`${base}/${type}/${id}?updateMask.fieldPaths=notified&currentDocument.updateTime=${encodeURIComponent(d.updateTime)}`,
        { method: "PATCH", headers: H, body: JSON.stringify({ fields: { notified: { booleanValue: true } } }) });
      if (!m.ok) return json({ ok: true, skip: "race" });

      // 3) build the message
      const money = (c, cur) => `${(c / 100).toFixed(2)} ${cur || "د.ل"}`;
      const title = type === "orders" ? "🛒 طلب شراء جديد" : "💰 طلب شحن جديد";
      const body = type === "orders"
        ? `${S("uName")} — ${S("productName")} ${S("optionLabel")} — ${money(N("price"), S("cur"))}`
        : `${S("uName")} — محفظة ${S("methodName")} — ${money(N("amount"), S("cur"))}`;
      const site = (req.headers.get("Origin") || "https://cardplay.com.ly").replace(/\/+$/, "");

      // 4) send to every admin device
      const lt = await fetch(`${base}/adminTokens?pageSize=100`, { headers: H });
      const docs = (await lt.json()).documents || [];
      let sent = 0;
      await Promise.all(docs.map(async td => {
        const token = td.fields?.token?.stringValue; if (!token) return;
        const s = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
          method: "POST", headers: H,
          body: JSON.stringify({ message: { token, webpush: {
            headers: { Urgency: "high", TTL: "86400" },
            notification: { title, body, icon: `${site}/img/icon-192.png`, badge: `${site}/img/icon-192.png`, dir: "rtl", lang: "ar", tag: (type === "orders" ? "o" : "t") + id, renotify: true },
            fcm_options: { link: `${site}/admin.html` } } } })
        });
        if (s.ok) sent++;
        else if (s.status === 404 || s.status === 400) await fetch(`https://firestore.googleapis.com/v1/${td.name}`, { method: "DELETE", headers: H }); // dead token
      }));
      return json({ ok: true, sent });
    } catch (e) {
      return json({ ok: false, error: String(e && e.message || e) }, 500);
    }
  }
};

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
  if (!j.access_token) throw new Error("auth failed: " + JSON.stringify(j));
  cached = { token: j.access_token, exp: Date.now() + 50 * 60 * 1000 };
  return j.access_token;
}
function b64url(bytes) { let s = ""; bytes.forEach(b => s += String.fromCharCode(b)); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
