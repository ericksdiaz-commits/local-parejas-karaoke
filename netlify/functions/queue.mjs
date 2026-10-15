import { getStore } from "@netlify/blobs";

// Cada registro es su propia entrada ("s/<id>"), así dos personas pueden anotarse al mismo tiempo sin pisarse.
const store = () => getStore({ name: "karaoke", consistency: "strong" });

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const clean = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

async function listAll(s) {
  const { blobs } = await s.list({ prefix: "s/" });
  const items = await Promise.all(
    blobs.map(async (b) => {
      const v = await s.get(b.key, { type: "json" });
      return v ? { id: b.key.slice(2), ...v } : null;
    })
  );
  return items.filter(Boolean).sort((a, b) => a.createdAt - b.createdAt);
}

export default async (req) => {
  const s = store();

  if (req.method === "GET") {
    return json({ items: await listAll(s) });
  }

  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);

  let body;
  try { body = await req.json(); } catch { return json({ error: "Datos inválidos" }, 400); }

  // Registro público
  if (!body.action || body.action === "add") {
    const nombre = clean(body.nombre, 40);
    const cancion = clean(body.cancion, 80);
    const artista = clean(body.artista, 60);
    if (!nombre || !cancion) return json({ error: "Falta el nombre o la canción" }, 400);
    const all = await listAll(s);
    if (all.length >= 300) return json({ error: "La lista está llena" }, 429);
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const item = { nombre, cancion, artista, status: "waiting", createdAt: Date.now() };
    await s.setJSON("s/" + id, item);
    return json({ ok: true, id });
  }

  // Acciones del anfitrión: requieren el PIN guardado en la variable HOST_PIN de Netlify
  const pin = Netlify.env.get("HOST_PIN");
  if (!pin) return json({ error: "Falta configurar HOST_PIN en Netlify" }, 500);
  if (String(body.pin || "") !== pin) return json({ error: "PIN incorrecto" }, 401);

  if (body.action === "check") return json({ ok: true });

  if (body.action === "next") {
    const all = await listAll(s);
    const singing = all.filter((i) => i.status === "singing");
    for (const i of singing) {
      await s.setJSON("s/" + i.id, { ...strip(i), status: "done", doneAt: Date.now() });
    }
    const next = all.find((i) => i.status === "waiting");
    if (next) await s.setJSON("s/" + next.id, { ...strip(next), status: "singing" });
    return json({ ok: true });
  }

  if (body.action === "remove" && body.id) {
    await s.delete("s/" + clean(body.id, 40));
    return json({ ok: true });
  }

  if (body.action === "reset") {
    const { blobs } = await s.list({ prefix: "s/" });
    await Promise.all(blobs.map((b) => s.delete(b.key)));
    return json({ ok: true });
  }

  return json({ error: "Acción desconocida" }, 400);
};

function strip(i) { const { id, ...rest } = i; return rest; }

export const config = { path: "/api/queue" };
