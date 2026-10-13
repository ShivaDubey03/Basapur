import { getStore } from "@netlify/blobs";

export const config = { path: "/api/*" };

const json = (d, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });
const clean = (v, n) => String(v || "").replace(/[<>]/g, "").trim().slice(0, n);

export default async (req) => {
  const photos = getStore("ramlila-photos");
  const cards = getStore("ramlila-cards");
  const vids = getStore("ramlila-videos");
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api\/?/, "");
  const m = req.method;
  const key = req.headers.get("x-admin-key");
  const isAdmin = !!key && key === Netlify.env.get("ADMIN_KEY");
  const moderate = Netlify.env.get("MODERATE") !== "false"; // approval is ON by default
  const list = async (s) => {
    const { blobs } = await s.list({ prefix: "meta/" });
    return (await Promise.all(blobs.map((b) => s.get(b.key, { type: "json" })))).filter(Boolean);
  };
  const bump = async (s, id, fn) => {
    const meta = await s.get("meta/" + id, { type: "json" });
    if (!meta) return null;
    fn(meta);
    await s.setJSON("meta/" + id, meta);
    return meta;
  };

  // ---------- PHOTOS ----------
  if (m === "GET" && path === "photos") {
    const items = (await list(photos)).filter((p) => isAdmin || p.approved).sort((a, b) => b.ts - a.ts);
    return json(items);
  }
  if (m === "GET" && path.startsWith("img/")) {
    const data = await photos.get("img/" + path.slice(4), { type: "arrayBuffer" });
    if (!data) return new Response("Not found", { status: 404 });
    return new Response(data, { headers: { "content-type": "image/jpeg", "cache-control": "public, max-age=31536000, immutable" } });
  }
  if (m === "POST" && path === "photos") {
    const form = await req.formData();
    const file = form.get("file");
    if (!file || typeof file === "string" || !file.type.startsWith("image/")) return json({ error: "कृपया एक फोटो चुनें / Please choose a photo" }, 400);
    if (file.size > 3 * 1024 * 1024) return json({ error: "फोटो 3 MB से छोटी होनी चाहिए / Photo must be under 3 MB" }, 400);
    const id = crypto.randomUUID();
    const meta = { id, name: clean(form.get("name"), 40) || "श्रद्धालु", caption: clean(form.get("caption"), 140), day: clean(form.get("day"), 10), likes: 0, ts: Date.now(), approved: !moderate };
    await photos.set("img/" + id, await file.arrayBuffer());
    await photos.setJSON("meta/" + id, meta);
    return json({ ok: true, approved: meta.approved, id });
  }
  if (m === "POST" && path.startsWith("like/")) {
    const r = await bump(photos, path.slice(5), (x) => (x.likes = (x.likes || 0) + 1));
    return r ? json({ likes: r.likes }) : json({ error: "not found" }, 404);
  }

  // ---------- VIDEOS (YouTube links) ----------
  if (m === "GET" && path === "videos") {
    return json((await list(vids)).filter((v) => isAdmin || v.approved).sort((a, b) => b.ts - a.ts));
  }
  if (m === "POST" && path === "videos") {
    const b = await req.json().catch(() => ({}));
    const yt = (String(b.url || "").match(/(?:youtu\.be\/|v=|embed\/|shorts\/|live\/)([\w-]{11})/) || [])[1];
    if (!yt) return json({ error: "सही YouTube लिंक डालें / Enter a valid YouTube link" }, 400);
    const id = crypto.randomUUID();
    const meta = { id, yt, title: clean(b.title, 80) || "रामलीला वीडियो", name: clean(b.name, 40), ts: Date.now(), approved: isAdmin || !moderate };
    await vids.setJSON("meta/" + id, meta);
    return json({ ok: true, approved: meta.approved });
  }

  // ---------- ID CARDS ----------
  if (m === "POST" && path === "cards") {
    const f = await req.formData();
    const photo = f.get("photo");
    const d = { name: clean(f.get("name"), 40), age: clean(f.get("age"), 3), mobile: clean(f.get("mobile"), 10), address: clean(f.get("address"), 140) };
    if (!photo || typeof photo === "string" || !photo.type.startsWith("image/") || photo.size > 3 * 1024 * 1024) return json({ error: "Photo missing or too large" }, 400);
    if (!d.name || !(+d.age >= 1 && +d.age <= 120) || !/^[6-9]\d{9}$/.test(d.mobile) || d.address.length < 5) return json({ error: "Please fill all details correctly" }, 400);
    const all = await list(cards);
    const dup = all.find((x) => x.mobile === d.mobile && x.name.toLowerCase() === d.name.toLowerCase());
    if (dup) return json({ ok: true, no: dup.no, existing: true, status: dup.status });
    const last = all.reduce((mx, x) => Math.max(mx, parseInt(String(x.no).split("-").pop(), 10) || 0), 0);
    const no = "ARS-26-" + String(last + 1).padStart(4, "0");
    const id = crypto.randomUUID();
    await cards.set("img/" + id, await photo.arrayBuffer());
    await cards.setJSON("meta/" + id, { id, no, ...d, ts: Date.now(), status: "pending" });
    return json({ ok: true, no, status: "pending" });
  }
  if (m === "POST" && path === "cards/lookup") {
    const b = await req.json().catch(() => ({}));
    const c = (await list(cards)).find((x) => x.no === String(b.no || "").toUpperCase() && x.mobile === String(b.mobile || ""));
    if (!c) return json({ error: "not found" }, 404);
    if (c.status !== "approved") return json({ status: c.status });
    return json({ status: "approved", card: { id: c.id, no: c.no, name: c.name, age: c.age, mobile: c.mobile, address: c.address } });
  }
  if (m === "GET" && path.startsWith("cimg/")) {
    const id = path.slice(5);
    const c = await cards.get("meta/" + id, { type: "json" });
    const ok = c && (isAdmin || (c.status === "approved" && url.searchParams.get("m") === c.mobile));
    if (!ok) return new Response("Forbidden", { status: 403 });
    const data = await cards.get("img/" + id, { type: "arrayBuffer" });
    return new Response(data, { headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=600" } });
  }

  // ---------- ADMIN ONLY ----------
  if (!isAdmin) return json({ error: "Unauthorized" }, 401);

  if (m === "GET" && path === "admin/cards") {
    return json((await list(cards)).sort((a, b) => (a.status === "pending" ? -1 : 1) - (b.status === "pending" ? -1 : 1) || b.ts - a.ts));
  }
  if (m === "POST" && path.startsWith("cards/approve/")) {
    const r = await bump(cards, path.slice(14), (x) => (x.status = "approved"));
    return r ? json({ ok: true }) : json({ error: "not found" }, 404);
  }
  if (m === "DELETE" && path.startsWith("cards/")) {
    const id = path.slice(6);
    await cards.delete("meta/" + id); await cards.delete("img/" + id);
    return json({ ok: true });
  }
  if (m === "POST" && path.startsWith("videos/approve/")) {
    const r = await bump(vids, path.slice(15), (x) => (x.approved = true));
    return r ? json({ ok: true }) : json({ error: "not found" }, 404);
  }
  if (m === "DELETE" && path.startsWith("videos/")) {
    await vids.delete("meta/" + path.slice(7));
    return json({ ok: true });
  }
  if (m === "POST" && path.startsWith("approve/")) {
    const r = await bump(photos, path.slice(8), (x) => (x.approved = true));
    return r ? json({ ok: true }) : json({ error: "not found" }, 404);
  }
  if (m === "DELETE" && path.startsWith("photos/")) {
    const id = path.slice(7);
    await photos.delete("meta/" + id); await photos.delete("img/" + id);
    return json({ ok: true });
  }
  return json({ error: "Not found" }, 404);
};
