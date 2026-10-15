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
    const [items, tournament] = await Promise.all([listAll(s), s.get("t", { type: "json" })]);
    return json({ items, tournament: tournament || null });
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

  // Torneo: llaves de eliminación directa con los inscritos
  if (body.action === "t-start") {
    const all = await listAll(s);
    const seen = new Set();
    const entrants = [];
    for (const i of all) {
      const key = i.nombre.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      entrants.push({ nombre: i.nombre, cancion: i.cancion, artista: i.artista });
    }
    if (entrants.length < 2) return json({ error: "Se necesitan al menos 2 inscritos" }, 400);
    for (let k = entrants.length - 1; k > 0; k--) {
      const j = Math.floor(Math.random() * (k + 1));
      [entrants[k], entrants[j]] = [entrants[j], entrants[k]];
    }
    const t = { status: "live", rounds: [pairUp(entrants)], champion: null, startedAt: Date.now() };
    advance(t);
    await s.setJSON("t", t);
    return json({ ok: true });
  }

  if (body.action === "t-win") {
    const t = await s.get("t", { type: "json" });
    if (!t || t.status !== "live") return json({ error: "No hay torneo en curso" }, 400);
    const round = t.rounds[t.rounds.length - 1];
    const m = round[Number(body.match)];
    if (!m || m.winner || !m.b) return json({ error: "Ese duelo ya se decidió" }, 400);
    if (body.side !== "a" && body.side !== "b") return json({ error: "Elige un ganador" }, 400);
    m.winner = body.side;
    advance(t);
    await s.setJSON("t", t);
    return json({ ok: true });
  }

  if (body.action === "t-undo") {
    const t = await s.get("t", { type: "json" });
    if (!t) return json({ error: "No hay torneo" }, 400);
    // Deshace la última decisión: si la ronda actual no tiene ganadores, vuelve a la anterior
    let round = t.rounds[t.rounds.length - 1];
    if (t.rounds.length > 1 && !round.some((m) => m.winner && m.b)) {
      t.rounds.pop();
      round = t.rounds[t.rounds.length - 1];
    }
    const decided = round.map((m, idx) => ({ m, idx })).filter((x) => x.m.winner && x.m.b);
    if (!decided.length) return json({ error: "No hay nada que deshacer" }, 400);
    decided[decided.length - 1].m.winner = null;
    t.status = "live"; t.champion = null;
    await s.setJSON("t", t);
    return json({ ok: true });
  }

  if (body.action === "t-end") {
    await s.delete("t");
    return json({ ok: true });
  }

  if (body.action === "reset") {
    await s.delete("t");
    const { blobs } = await s.list({ prefix: "s/" });
    await Promise.all(blobs.map((b) => s.delete(b.key)));
    return json({ ok: true });
  }

  return json({ error: "Acción desconocida" }, 400);
};

// Empareja en orden; si sobra uno, pasa directo (bye)
function pairUp(list) {
  const round = [];
  for (let k = 0; k < list.length; k += 2) {
    const a = list[k], b = list[k + 1] || null;
    round.push({ a, b, winner: b ? null : "a" });
  }
  return round;
}

// Si la ronda actual terminó, arma la siguiente o corona al campeón
function advance(t) {
  for (;;) {
    const round = t.rounds[t.rounds.length - 1];
    if (round.some((m) => !m.winner)) return;
    const winners = round.map((m) => m[m.winner]);
    if (winners.length === 1) { t.status = "done"; t.champion = winners[0]; return; }
    t.rounds.push(pairUp(winners));
  }
}

function strip(i) { const { id, ...rest } = i; return rest; }

export const config = { path: "/api/queue" };
