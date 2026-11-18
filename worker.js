// Hab ich …auch! – Lobby-Server (Cloudflare Worker + Durable Object)
// Ein Raum = ein Durable Object (Name = 4-stelliger Code). Spielstand liegt im Speicher des Objekts.

const MAX_PLAYERS = 12;
const MIN_START = 2;       // laut Regeln ab 3, zum Testen reichen 2
const NAME_MAX = 16;

// ------------------------------------------------------------------
// Reine Raumlogik (ohne WebSockets, daher in Node testbar)
// ------------------------------------------------------------------
export class RoomLogic {
  constructor() {
    this.code = null;
    this.created = false;
    this.phase = "lobby";      // lobby | write | compare | final
    this.round = 0;            // 0..2
    this.qi = 0;               // 0..2 (Frage innerhalb der Runde)
    this.qs = [];              // 9 Fragetexte (3 Runden x 3 Fragen)
    this.players = [];         // {id, name, on, ready, ev, sc:[null,null,null], left}
    this.hostId = null;
    this.seq = 0;
    this.open = false;         // false: Frage wird nur gezeigt, der Host darf sie noch tauschen
  }

  newId() { return "p" + (++this.seq) + Math.random().toString(36).slice(2, 8); }
  get live() { return this.players.filter(p => !p.left); }
  get online() { return this.live.filter(p => p.on); }
  find(id) { return this.players.find(p => p.id === id && !p.left); }

  join({ name, pid, create, code }) {
    if (code) this.code = this.code || code;
    if (pid) {
      const p = this.find(pid);
      if (p) { p.on = true; this.fixHost(); return { id: p.id }; }
      return { err: "Dein Platz ist nicht mehr da. Tritt neu bei." };
    }
    if (create) { if (this.created) return { err: "exists" }; }
    else if (!this.created) return { err: "Raum nicht gefunden." };
    if (this.phase !== "lobby") return { err: "Das Spiel läuft schon." };
    if (this.live.length >= MAX_PLAYERS) return { err: "Der Raum ist voll." };
    let n = String(name || "").replace(/\s+/g, " ").trim().slice(0, NAME_MAX);
    if (!n) return { err: "Bitte einen Namen eingeben." };
    const base = n; let k = 2;
    while (this.live.some(p => p.name.toLowerCase() === n.toLowerCase())) n = base.slice(0, NAME_MAX - 2) + " " + k++;
    const p = { id: this.newId(), name: n, on: true, ready: false, ev: false, sc: [null, null, null], left: false };
    this.players.push(p);
    if (create) this.created = true;
    if (!this.hostId) this.hostId = p.id;
    return { id: p.id };
  }

  fixHost() {
    const h = this.find(this.hostId);
    if (h) return;   // Host bleibt Host, auch wenn er kurz weg ist (Handy gesperrt o. ä.)
    const n = this.online[0] || this.live[0];
    this.hostId = n ? n.id : null;
  }

  disconnect(id, explicitLeave) {
    const p = this.find(id); if (!p) return;
    p.on = false;
    if (explicitLeave) p.left = true;
    if (this.phase === "lobby" && (explicitLeave || false)) this.players = this.players.filter(x => x.id !== id);
    this.fixHost();
    this.advance();
  }

  advance() {
    if (this.phase !== "write") return;
    const on = this.online;
    if (!on.length || !on.every(p => p.ready)) return;
    this.live.forEach(p => { p.ready = false; });
    this.open = false;
    this.qi++;
    if (this.qi >= 3) { this.qi = 2; this.phase = "compare"; }
  }

  act(id, m) {
    const p = this.find(id); if (!p) return "Unbekannte Person.";
    const host = id === this.hostId;
    switch (m.t) {
      case "start": {
        if (!host) return "Nur der Host kann starten.";
        if (this.phase !== "lobby") return "Läuft schon.";
        if (this.online.length < MIN_START) return "Es braucht mindestens " + MIN_START + " Personen.";
        const qs = Array.isArray(m.qs) ? m.qs.map(x => String(x || "").trim().slice(0, 120)) : [];
        if (qs.length !== 9 || qs.some(x => !x)) return "Ungültige Fragen.";
        this.qs = qs; this.phase = "write"; this.round = 0; this.qi = 0; this.open = false;
        this.players = this.players.filter(x => !x.left);
        this.players.forEach(x => { x.ready = false; x.ev = false; x.sc = [null, null, null]; });
        return null;
      }
      case "claim":
        if (this.find(this.hostId) && !this.find(this.hostId).on) this.hostId = id;
        return null;
      case "go":
        if (!host) return "Nur der Host gibt die Frage frei.";
        if (this.phase === "write") this.open = true;
        return null;
      case "ready":
        if (this.phase !== "write" || !this.open) return null;
        p.ready = true; this.advance(); return null;
      case "swap": {
        if (!host || this.phase !== "write") return "Nicht möglich.";
        if (this.open) return "Die Frage ist schon freigegeben.";
        const t = String(m.text || "").trim().slice(0, 120); if (!t) return "Ungültig.";
        this.qs[this.round * 3 + this.qi] = t; return null;
      }
      case "eval": {
        if (this.phase !== "compare") return null;
        const s = Math.max(0, Math.min(99, parseInt(m.score, 10) || 0));
        p.sc[this.round] = s; p.ev = true; return null;
      }
      case "unevel":
        if (this.phase === "compare") { p.ev = false; p.sc[this.round] = null; }
        return null;
      case "nextround":
        if (!host) return "Nur der Host kann weiter.";
        if (this.phase !== "compare") return null;
        this.round++;
        this.live.forEach(x => { x.ready = false; x.ev = false; });
        if (this.round >= 3) { this.round = 2; this.phase = "final"; }
        else { this.phase = "write"; this.qi = 0; this.open = false; }
        return null;
      case "restart":
        if (!host) return "Nur der Host kann neu starten.";
        if (this.phase !== "final") return null;
        this.players = this.players.filter(x => !x.left && x.on);
        this.players.forEach(x => { x.ready = false; x.ev = false; x.sc = [null, null, null]; });
        this.phase = "lobby"; this.round = 0; this.qi = 0; this.qs = []; this.fixHost();
        return null;
      default: return null;
    }
  }

  view() {
    const cur = this.round * 3;
    return {
      code: this.code, phase: this.phase, open: this.open, round: this.round, qi: this.qi, host: this.hostId,
      q: this.phase === "write" ? this.qs[cur + this.qi] : null,
      rq: (this.phase === "compare" || this.phase === "final") ? this.qs.slice(cur, cur + 3) : null,
      players: this.live.map(p => ({ id: p.id, name: p.name, on: p.on, ready: p.ready, ev: p.ev, sc: p.sc })),
    };
  }
}

// ------------------------------------------------------------------
// Durable Object: verbindet WebSockets mit der Logik
// ------------------------------------------------------------------
export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env || {};
    this.logic = new RoomLogic();
    this.socks = new Map();   // WebSocket -> Spieler-ID
    this.ips = new Map();     // WebSocket -> IP (nur für die Sperre)
    this.joining = new Set();
    // Spielstand überlebt, wenn Cloudflare das Objekt zwischendurch aus dem Speicher nimmt
    state.blockConcurrencyWhile(async () => {
      try {
        const saved = await state.storage.get("logic");
        if (saved) { Object.assign(this.logic, saved); this.logic.players.forEach(p => { p.on = false; }); }
      } catch (e) { /* neu starten */ }
    });
  }
  save() { try { this.state.storage.put("logic", JSON.parse(JSON.stringify(this.logic))); } catch (e) {} }

  async limit(op, key, max) {
    const now = Date.now(), k = "lim:" + key;
    const d = (await this.state.storage.get(k)) || { fails: 0, lock: 0, strikes: 0, sAt: 0 };
    if (op === "ok") { d.fails = 0; }
    else if (op === "fail" && d.lock <= now) {
      d.fails++;
      if (d.fails >= max) {
        d.strikes = (now - d.sAt < 86400000 ? d.strikes : 0) + 1; d.sAt = now;
        d.lock = now + (d.strikes === 1 ? 15 : 60) * 60000; d.fails = 0;
      }
    }
    if (op !== "check") await this.state.storage.put(k, d);
    return d.lock > now ? d.lock : 0;
  }

  async fetch(request) {
    if (new URL(request.url).pathname === "/_limit") {
      const b = await request.json();
      return new Response(JSON.stringify({ until: await this.limit(b.op, String(b.key).slice(0, 80), b.max | 0) }));
    }
    this.ip = request.headers.get("CF-Connecting-IP") || "?";
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Erwartet WebSocket", { status: 426 });
    const code = new URL(request.url).pathname.split("/").pop().toUpperCase();
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    this.ips.set(server, this.ip);
    server.addEventListener("message", ev => this.onMessage(server, ev, code));
    server.addEventListener("close", () => this.onClose(server));
    server.addEventListener("error", () => this.onClose(server));
    return new Response(null, { status: 101, webSocket: client });
  }

  send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch (e) { /* Verbindung weg */ } }
  broadcast() {
    const s = this.logic.view();
    for (const [ws, id] of this.socks) this.send(ws, { t: "state", you: id, s });
    this.save();
  }

  onMessage(ws, ev, code) {
    let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (!m || typeof m.t !== "string") return;
    if (m.t === "ping") return this.send(ws, { t: "pong" });
    if (m.t === "join") return this.onJoin(ws, m, code);
    const id = this.socks.get(ws); if (!id) return;
    if (m.t === "leave") { this.socks.delete(ws); this.logic.disconnect(id, true); try { ws.close(1000, "tschüss"); } catch (e) {} return this.broadcast(); }
    const err = this.logic.act(id, m);
    if (err) this.send(ws, { t: "err", msg: err });
    this.broadcast();
  }

  async onJoin(ws, m, code) {
    if (this.socks.has(ws) || this.joining.has(ws)) return;
    this.joining.add(ws);
    const fail = msg => { this.send(ws, { t: "err", msg, fatal: true }); try { ws.close(1000, "x"); } catch (e) {} };
    try {
      const ip = this.ips.get(ws) || "?";
      if (!m.pid) {
        const pk = "pw:" + ip, jk = "join:" + ip;
        if (m.create) {   // Raum anlegen nur mit Passwort
          let u = await lim(this.env, "check", pk, LIMIT_PW);
          if (u) return fail(lockText(u));
          if (!this.env.PASSWORT) return fail("Auf dem Server ist noch kein Passwort eingerichtet.");
          if (!roleOf(this.env, m.pw)) { u = await lim(this.env, "fail", pk, LIMIT_PW); return fail(u ? lockText(u) : "Das Passwort stimmt nicht."); }
          await lim(this.env, "ok", pk, LIMIT_PW);
        } else {          // Beitreten: nur mit existierendem Raumcode, falsche Codes werden gezählt
          const u = await lim(this.env, "check", jk, LIMIT_JOIN);
          if (u) return fail(lockText(u));
          if (!this.logic.created) { const u2 = await lim(this.env, "fail", jk, LIMIT_JOIN); return fail(u2 ? lockText(u2) : "Raum nicht gefunden."); }
        }
      }
      const r = this.logic.join({ name: m.name, pid: m.pid, create: !!m.create, code });
      if (r.err) return fail(r.err);
      for (const [w, id] of this.socks) if (id === r.id && w !== ws) { this.socks.delete(w); try { w.close(1000, "neu"); } catch (e) {} }
      this.socks.set(ws, r.id);
      this.send(ws, { t: "hello", you: r.id });
      this.broadcast();
    } finally { this.joining.delete(ws); }
  }

  onClose(ws) {
    this.ips.delete(ws);
    const id = this.socks.get(ws); if (!id) return;
    this.socks.delete(ws);
    this.logic.disconnect(id, false);
    this.broadcast();
  }
}

// ------------------------------------------------------------------
// Worker: leitet /ws/CODE an den passenden Raum weiter
// ------------------------------------------------------------------
// Das Passwort (PASSWORT) braucht nur, wer einen Raum anlegt. Beitreten geht mit dem Raumcode.
function roleOf(env, pw) {
  return env.PASSWORT && String(pw || "") === String(env.PASSWORT) ? "host" : null;
}

// ------------------------------------------------------------------
// Sperre bei zu vielen Fehlversuchen (pro IP): 1. Sperre 15 Minuten, danach je 1 Stunde.
// Die Zähler liegen im Durable Object "_limiter".
// ------------------------------------------------------------------
const LIMIT_PW = 5;      // falsche Passwörter bis zur Sperre
const LIMIT_JOIN = 10;   // falsche Raumcodes bis zur Sperre
async function lim(env, op, key, max) {
  try {
    const stub = env.ROOM.get(env.ROOM.idFromName("_limiter"));
    const r = await stub.fetch("https://limiter/_limit", { method: "POST", body: JSON.stringify({ op, key, max }) });
    return (await r.json()).until || 0;
  } catch (e) { return 0; }
}
const lockText = until => "Zu viele Versuche. Bitte warte noch " + Math.max(1, Math.ceil((until - Date.now()) / 60000)) + " Minuten.";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "POST, OPTIONS" };
    if (url.pathname === "/auth") {
      if (request.method === "OPTIONS") return new Response(null, { headers: cors });
      const ip = request.headers.get("CF-Connecting-IP") || "?";
      let role = null, pw = "";
      try { const b = await request.json(); pw = String(b.pw || ""); } catch (e) {}
      const hdr = { ...cors, "content-type": "application/json" };
      const until = await lim(env, "check", "pw:" + ip, LIMIT_PW);
      if (until) return new Response(JSON.stringify({ ok: false, locked: true, msg: lockText(until) }), { headers: hdr });
      role = roleOf(env, pw);
      if (role) await lim(env, "ok", "pw:" + ip, LIMIT_PW);
      else if (pw) { const u2 = await lim(env, "fail", "pw:" + ip, LIMIT_PW); if (u2) return new Response(JSON.stringify({ ok: false, locked: true, msg: lockText(u2) }), { headers: hdr }); }
      return new Response(JSON.stringify({ ok: !!role, role }), { headers: hdr });
    }
    const m = url.pathname.match(/^\/ws\/([A-Za-z0-9]{4})$/);
    if (!m) return new Response("Hab ich …auch! Lobby läuft.", { headers: { "content-type": "text/plain; charset=utf-8" } });
    const code = m[1].toUpperCase();
    const stub = env.ROOM.get(env.ROOM.idFromName(code));
    return stub.fetch(request);
  },
};
