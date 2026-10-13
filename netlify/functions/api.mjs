import { getStore } from "@netlify/blobs";

export const config = { path: "/api/*" };

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});
const clean = (value, max) => String(value || "").replace(/[<>]/g, "").trim().slice(0, max);

export default async (req) => {
  const photos = getStore("ramlila-photos");
  const cards = getStore("ramlila-cards");
  const settings = getStore("ramlila-settings");
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api\/?/, "");
  const method = req.method;
  const suppliedKey = req.headers.get("x-admin-key");
  const configuredKey = Netlify.env.get("ADMIN_KEY");
  const isAdmin = !!configuredKey && !!suppliedKey && suppliedKey === configuredKey;
  // This setting is only for PHOTO gallery moderation, not ID card approval.
  const moderatePhotos = Netlify.env.get("MODERATE") !== "false";

  const list = async (store) => {
    const { blobs } = await store.list({ prefix: "meta/" });
    const rows = await Promise.all(blobs.map((blob) => store.get(blob.key, { type: "json" })));
    return rows.filter(Boolean);
  };
  const bump = async (store, id, update) => {
    const meta = await store.get("meta/" + id, { type: "json" });
    if (!meta) return null;
    update(meta);
    await store.setJSON("meta/" + id, meta);
    return meta;
  };
  const getAutoApproval = async () => {
    const saved = await settings.get("card-auto-approval", { type: "json" });
    return saved?.enabled === true;
  };

  // ---------- PHOTO GALLERY ----------
  if (method === "GET" && path === "photos") {
    const items = (await list(photos))
      .filter((photo) => isAdmin || photo.approved)
      .sort((a, b) => b.ts - a.ts);
    return json(items);
  }

  if (method === "GET" && path.startsWith("img/")) {
    const id = path.slice(4);
    const data = await photos.get("img/" + id, { type: "arrayBuffer" });
    if (!data) return new Response("Not found", { status: 404 });
    return new Response(data, {
      headers: { "content-type": "image/jpeg", "cache-control": "public, max-age=31536000, immutable" }
    });
  }

  if (method === "POST" && path === "photos") {
    const form = await req.formData();
    const file = form.get("file");
    if (!file || typeof file === "string" || !file.type.startsWith("image/")) {
      return json({ error: "कृपया एक फोटो चुनें / Please choose a photo" }, 400);
    }
    if (file.size > 3 * 1024 * 1024) {
      return json({ error: "फोटो 3 MB से छोटी होनी चाहिए / Photo must be under 3 MB" }, 400);
    }
    const id = crypto.randomUUID();
    const meta = {
      id,
      name: clean(form.get("name"), 40) || "श्रद्धालु",
      caption: clean(form.get("caption"), 140),
      day: clean(form.get("day"), 10),
      likes: 0,
      ts: Date.now(),
      approved: !moderatePhotos
    };
    await photos.set("img/" + id, await file.arrayBuffer());
    await photos.setJSON("meta/" + id, meta);
    return json({ ok: true, approved: meta.approved, id });
  }

  if (method === "POST" && path.startsWith("like/")) {
    const result = await bump(photos, path.slice(5), (item) => {
      item.likes = (item.likes || 0) + 1;
    });
    return result ? json({ likes: result.likes }) : json({ error: "not found" }, 404);
  }

  // ---------- ID CARDS ----------
  if (method === "POST" && path === "cards") {
    const form = await req.formData();
    const photo = form.get("photo");
    const details = {
      name: clean(form.get("name"), 40),
      age: clean(form.get("age"), 3),
      mobile: clean(form.get("mobile"), 10),
      address: clean(form.get("address"), 140)
    };

    if (!photo || typeof photo === "string" || !photo.type.startsWith("image/") || photo.size > 3 * 1024 * 1024) {
      return json({ error: "Photo missing or too large (maximum 3 MB)" }, 400);
    }
    if (!details.name || !(+details.age >= 1 && +details.age <= 120) || !/^[6-9]\d{9}$/.test(details.mobile) || details.address.length < 5) {
      return json({ error: "Please fill all details correctly" }, 400);
    }

    const allCards = await list(cards);
    const duplicate = allCards.find((item) =>
      item.mobile === details.mobile && item.name.toLowerCase() === details.name.toLowerCase()
    );
    if (duplicate) {
      return json({
        ok: true,
        no: duplicate.no,
        existing: true,
        status: duplicate.status,
        autoApproved: false
      });
    }

    const lastNumber = allCards.reduce((max, item) =>
      Math.max(max, parseInt(String(item.no).split("-").pop(), 10) || 0), 0);
    const no = "ARS-26-" + String(lastNumber + 1).padStart(4, "0");
    const id = crypto.randomUUID();
    const autoApproved = await getAutoApproval();
    const status = autoApproved ? "approved" : "pending";

    await cards.set("img/" + id, await photo.arrayBuffer());
    await cards.setJSON("meta/" + id, {
      id, no, ...details, ts: Date.now(), status
    });

    return json({ ok: true, no, status, autoApproved });
  }

  if (method === "POST" && path === "cards/lookup") {
    const body = await req.json().catch(() => ({}));
    const card = (await list(cards)).find((item) =>
      item.no === String(body.no || "").toUpperCase() && item.mobile === String(body.mobile || "")
    );
    if (!card) return json({ error: "not found" }, 404);
    if (card.status !== "approved") return json({ status: card.status });
    return json({
      status: "approved",
      card: {
        id: card.id, no: card.no, name: card.name,
        age: card.age, mobile: card.mobile, address: card.address
      }
    });
  }

  if (method === "GET" && path.startsWith("cimg/")) {
    const id = path.slice(5);
    const card = await cards.get("meta/" + id, { type: "json" });
    const allowed = card && (isAdmin || (card.status === "approved" && url.searchParams.get("m") === card.mobile));
    if (!allowed) return new Response("Forbidden", { status: 403 });
    const data = await cards.get("img/" + id, { type: "arrayBuffer" });
    if (!data) return new Response("Not found", { status: 404 });
    return new Response(data, {
      headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=600" }
    });
  }

  // All remaining routes require a valid admin key.
  if (!isAdmin) return json({ error: "Unauthorized" }, 401);

  // ---------- ADMIN: ID CARD SETTINGS ----------
  if (method === "GET" && path === "admin/card-settings") {
    return json({ autoApproval: await getAutoApproval() });
  }

  if (method === "POST" && path === "admin/card-settings") {
    const body = await req.json().catch(() => null);
    if (!body || typeof body.autoApproval !== "boolean") {
      return json({ error: "Invalid setting" }, 400);
    }
    await settings.setJSON("card-auto-approval", { enabled: body.autoApproval });
    return json({ ok: true, autoApproval: body.autoApproval });
  }

  // ---------- ADMIN: ID CARDS ----------
  if (method === "GET" && path === "admin/cards") {
    const allCards = await list(cards);
    allCards.sort((a, b) =>
      (a.status === "pending" ? -1 : 1) - (b.status === "pending" ? -1 : 1) || b.ts - a.ts
    );
    return json(allCards);
  }

  if (method === "POST" && path.startsWith("cards/approve/")) {
    const result = await bump(cards, path.slice("cards/approve/".length), (item) => {
      item.status = "approved";
    });
    return result ? json({ ok: true }) : json({ error: "not found" }, 404);
  }

  if (method === "DELETE" && path.startsWith("cards/")) {
    const id = path.slice("cards/".length);
    await cards.delete("meta/" + id);
    await cards.delete("img/" + id);
    return json({ ok: true });
  }

  // ---------- ADMIN: PHOTO GALLERY ----------
  if (method === "POST" && path.startsWith("approve/")) {
    const result = await bump(photos, path.slice("approve/".length), (item) => {
      item.approved = true;
    });
    return result ? json({ ok: true }) : json({ error: "not found" }, 404);
  }

  if (method === "DELETE" && path.startsWith("photos/")) {
    const id = path.slice("photos/".length);
    await photos.delete("meta/" + id);
    await photos.delete("img/" + id);
    return json({ ok: true });
  }

  return json({ error: "Not found" }, 404);
};
