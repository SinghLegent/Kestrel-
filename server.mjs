// Kestrel Meet - zero-dependency signaling + app server (Node built-ins only).
// Media is peer-to-peer WebRTC (mesh); this server relays signaling over SSE,
// enforces roles, and stores scheduled meetings.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const PORT = Number(process.env.PORT || 3000);
const ICE = process.env.ICE_SERVERS
  ? JSON.parse(process.env.ICE_SERVERS)
  : [{ urls: 'stun:stun.l.google.com:19302' }];
const MAX_PEERS = 100;
const REACTIONS = ['👍', '👏', '❤️', '😂', '🎉', '😮'];

const CSP = "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'";
const SEC = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': CSP,
  'permissions-policy': 'camera=(self), microphone=(self), display-capture=(self)',
};
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.png': 'image/png', '.ico': 'image/x-icon',
};

// ---------- helpers ----------
const rid = (n = 8) => crypto.randomBytes(n).toString('hex');
const LETTERS = 'abcdefghjkmnpqrstuvwxyz';
const meetingCode = () => {
  const g = (n) => Array.from({ length: n }, () => LETTERS[crypto.randomInt(LETTERS.length)]).join('');
  return `${g(3)}-${g(4)}-${g(3)}`;
};
const safeEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const cleanName = (s) => String(s ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 40);
class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const err = (c, m) => new HttpError(c, m);

// ---------- meetings (persisted) ----------
const meetings = new Map();
const MFILE = path.join(DATA, 'meetings.json');
try { for (const m of JSON.parse(fs.readFileSync(MFILE, 'utf8'))) meetings.set(m.id, m); } catch { /* first run */ }
const saveMeetings = () => {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(MFILE, JSON.stringify([...meetings.values()], null, 1));
};
const publicMeeting = (m) => ({
  id: m.id, title: m.title, mode: m.mode, start: m.start, duration: m.duration,
  needsPasscode: !!m.passcode, waitingRoom: m.waitingRoom,
});

// ---------- rooms / peers ----------
const rooms = new Map();
const peers = new Map();
const isMod = (p) => p.role === 'host' || p.role === 'cohost';
const canSpeak = (p) => p.role !== 'attendee';

function getRoom(id) {
  let r = rooms.get(id);
  if (!r) {
    const m = meetings.get(id);
    if (!m) return null;
    r = {
      id, meeting: m, peers: new Map(), locked: false, waitingRoom: m.waitingRoom,
      perms: { share: m.mode !== 'webinar', chat: true, rename: true },
      chat: [], polls: [], questions: [], spotlight: null, sharer: null,
      breakouts: { rooms: [], open: false }, recording: null, cleanup: null,
    };
    rooms.set(id, r);
  }
  return r;
}
const pub = (p) => ({
  id: p.id, name: p.name, role: p.role, status: p.status, channel: p.channel,
  hand: p.hand, cam: p.cam, mic: p.mic, screen: p.screen, assign: p.assign,
});
const roomPublic = (r) => ({
  id: r.id, title: r.meeting.title, mode: r.meeting.mode, locked: r.locked,
  waitingRoom: r.waitingRoom, perms: r.perms, spotlight: r.spotlight,
  recording: r.recording, breakouts: r.breakouts,
  start: r.meeting.start, duration: r.meeting.duration,
});
function send(p, event, data) {
  if (!p) return;
  if (p.res && !p.res.writableEnded) p.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  else if (event === 'signal') {
    // The peer has joined but its event stream is not open yet (or is reconnecting): hold
    // WebRTC signals briefly so an early offer is not lost.
    (p.queue ||= []).push([event, data]);
    if (p.queue.length > 200) p.queue.shift();
  }
}
function sendRoster(r) {
  const all = [...r.peers.values()];
  for (const v of all) {
    const list = all.filter((q) => q.status === 'in' || isMod(v) || q.id === v.id).map(pub);
    send(v, 'roster', list);
  }
}
const sendRoom = (r) => { for (const p of r.peers.values()) send(p, 'room', roomPublic(r)); };
function pollsFor(r, p) {
  return r.polls.map((po) => ({
    id: po.id, question: po.question, options: po.options, open: po.open,
    counts: po.options.map((_, i) => Object.values(po.votes).filter((v) => v === i).length),
    mine: po.votes[p.id] ?? null,
  }));
}
const sendPolls = (r) => { for (const p of r.peers.values()) if (p.status === 'in') send(p, 'polls', pollsFor(r, p)); };
const sendQuestions = (r) => { for (const p of r.peers.values()) if (p.status === 'in') send(p, 'questions', r.questions); };
function histFor(r, p) {
  return r.chat.filter((m) => m.channel === p.channel);
}
function move(r, p, channel) {
  p.channel = channel;
  send(p, 'moved', { channel });
  send(p, 'chathist', histFor(r, p));
}
function dropPeer(p, reason) {
  const r = p.room;
  if (reason) send(p, 'removed', { reason });
  if (p.res && !p.res.writableEnded) p.res.end();
  clearTimeout(p.dropTimer);
  r.peers.delete(p.id); peers.delete(p.id);
  if (r.sharer === p.id) r.sharer = null;
  if (r.spotlight === p.id) { r.spotlight = null; sendRoom(r); }
  sendRoster(r);
  if (r.peers.size === 0) { r.cleanup = setTimeout(() => { if (r.peers.size === 0) rooms.delete(r.id); }, 60000); }
}

// ---------- authenticated actions ----------
const H = {};
const requireMod = (p) => { if (!isMod(p)) throw err(403, 'moderator-only'); };
const requireHost = (p) => { if (p.role !== 'host') throw err(403, 'host-only'); };
const targetOf = (r, b) => {
  const t = r.peers.get(b.target);
  if (!t) throw err(404, 'peer-gone');
  return t;
};

H.signal = (p, r, b) => {
  const t = peers.get(b.to);
  if (!t || t.room !== r || t.status !== 'in' || p.status !== 'in' || t.channel !== p.channel) throw err(404, 'peer-gone');
  send(t, 'signal', { from: p.id, data: b.data });
  return { ok: true };
};

H.state = (p, r, b) => {
  if (typeof b.cam === 'boolean') p.cam = b.cam;
  if (typeof b.mic === 'boolean') p.mic = b.mic;
  if ('screen' in b) {
    if (b.screen) {
      if (p.role === 'attendee' || !(isMod(p) || r.perms.share)) throw err(403, 'share-blocked');
      if (r.sharer && r.sharer !== p.id) {
        if (!isMod(p)) throw err(409, 'someone-sharing');
        const o = r.peers.get(r.sharer);
        if (o) { o.screen = null; send(o, 'stopshare', { by: p.id }); }
      }
      p.screen = String(b.screen).slice(0, 80); r.sharer = p.id;
    } else {
      p.screen = null; if (r.sharer === p.id) r.sharer = null;
    }
  }
  if (typeof b.name === 'string' && (isMod(p) || r.perms.rename)) p.name = cleanName(b.name) || p.name;
  sendRoster(r);
  return { ok: true };
};

H.chat = (p, r, b) => {
  if (p.status !== 'in') throw err(403, 'not-admitted');
  const text = String(b.text ?? '').trim().slice(0, 2000);
  if (!text) throw err(400, 'empty');
  if (!(isMod(p) || r.perms.chat)) throw err(403, 'chat-blocked');
  const now = Date.now();
  p.chatTimes = p.chatTimes.filter((t) => now - t < 3000);
  if (p.chatTimes.length >= 8) throw err(429, 'slow-down');
  p.chatTimes.push(now);
  const to = b.to && b.to !== 'all' ? String(b.to) : 'all';
  const msg = { id: rid(4), from: p.id, name: p.name, to, text, ts: now, channel: p.channel };
  if (to === 'all') {
    r.chat.push(msg); if (r.chat.length > 500) r.chat.shift();
    for (const q of r.peers.values()) if (q.status === 'in' && q.channel === p.channel) send(q, 'chat', msg);
  } else {
    const t = r.peers.get(to);
    if (!t || t.status !== 'in') throw err(404, 'peer-gone');
    send(p, 'chat', msg); if (t !== p) send(t, 'chat', msg);
  }
  return { ok: true };
};

H.hand = (p, r, b) => { p.hand = !!b.on; sendRoster(r); return { ok: true }; };

H.reaction = (p, r, b) => {
  if (!REACTIONS.includes(b.emoji) || p.status !== 'in') throw err(400, 'bad-reaction');
  for (const q of r.peers.values()) if (q.status === 'in' && q.channel === p.channel) send(q, 'reaction', { from: p.id, emoji: b.emoji });
  return { ok: true };
};

H.record = (p, r, b) => {
  requireMod(p);
  r.recording = b.on ? { by: p.id, name: p.name, ts: Date.now() } : null;
  sendRoom(r);
  return { ok: true };
};

H.poll = (p, r, b) => {
  requireMod(p);
  if (b.action === 'create') {
    const question = String(b.question ?? '').trim().slice(0, 200);
    const options = (Array.isArray(b.options) ? b.options : []).map((s) => String(s).trim().slice(0, 100)).filter(Boolean).slice(0, 10);
    if (!question || options.length < 2) throw err(400, 'need-question-and-two-options');
    if (r.polls.length >= 50) throw err(400, 'too-many-polls');
    r.polls.push({ id: rid(4), question, options, votes: {}, open: true });
  } else if (b.action === 'close') {
    const po = r.polls.find((x) => x.id === b.id); if (po) po.open = false;
  } else throw err(400, 'bad-action');
  sendPolls(r);
  return { ok: true };
};

H.vote = (p, r, b) => {
  const po = r.polls.find((x) => x.id === b.id);
  if (!po || !po.open || p.status !== 'in') throw err(404, 'poll-closed');
  const i = Number(b.option);
  if (!Number.isInteger(i) || i < 0 || i >= po.options.length) throw err(400, 'bad-option');
  po.votes[p.id] = i;
  sendPolls(r);
  return { ok: true };
};

H.question = (p, r, b) => {
  const text = String(b.text ?? '').trim().slice(0, 500);
  if (!text || p.status !== 'in') throw err(400, 'empty');
  if (r.questions.length >= 200) throw err(400, 'too-many-questions');
  r.questions.push({ id: rid(4), from: p.id, name: p.name, text, ts: Date.now(), answer: null, answeredBy: null });
  sendQuestions(r);
  return { ok: true };
};

H.answer = (p, r, b) => {
  if (!(isMod(p) || p.role === 'panelist')) throw err(403, 'panelist-only');
  const q = r.questions.find((x) => x.id === b.id);
  if (!q) throw err(404, 'no-question');
  q.answer = String(b.text ?? '').trim().slice(0, 1000) || null;
  q.answeredBy = q.answer ? p.name : null;
  sendQuestions(r);
  return { ok: true };
};

H.help = (p, r) => {
  if (p.channel === 'main') throw err(400, 'not-in-breakout');
  for (const q of r.peers.values()) if (isMod(q)) send(q, 'help', { from: p.id, name: p.name, channel: p.channel });
  return { ok: true };
};

H.channel = (p, r, b) => {
  if (b.to !== 'main' || p.channel === 'main') throw err(400, 'bad-channel');
  move(r, p, 'main'); sendRoster(r);
  return { ok: true };
};

H.leave = (p) => { dropPeer(p); return { ok: true }; };

H.host = (p, r, b) => {
  requireMod(p);
  const a = b.action;
  switch (a) {
    case 'mute': {
      const t = targetOf(r, b);
      if (t.role === 'host' && p.role !== 'host') throw err(403, 'host-only');
      t.mic = false; send(t, 'mute', { by: p.name }); break;
    }
    case 'mute-all':
      for (const t of r.peers.values()) if (!isMod(t) && t.status === 'in') { t.mic = false; send(t, 'mute', { by: p.name }); }
      break;
    case 'remove': {
      const t = targetOf(r, b);
      if (t.role === 'host' || (t.role === 'cohost' && p.role !== 'host')) throw err(403, 'not-allowed');
      dropPeer(t, 'removed'); return { ok: true };
    }
    case 'lock': r.locked = !!b.on; sendRoom(r); break;
    case 'waiting': r.waitingRoom = !!b.on; sendRoom(r); break;
    case 'perm':
      if (!['share', 'chat', 'rename'].includes(b.key)) throw err(400, 'bad-perm');
      r.perms[b.key] = !!b.on; sendRoom(r); break;
    case 'admit': {
      const t = targetOf(r, b);
      if (t.status === 'waiting') { t.status = 'in'; send(t, 'admitted', {}); send(t, 'chathist', histFor(r, t)); sendRoster(r); sendRoom(r); sendPolls(r); sendQuestions(r); }
      break;
    }
    case 'admit-all':
      for (const t of r.peers.values()) if (t.status === 'waiting') { t.status = 'in'; send(t, 'admitted', {}); send(t, 'chathist', histFor(r, t)); }
      sendRoster(r); sendPolls(r); sendQuestions(r);
      break;
    case 'deny': { const t = targetOf(r, b); if (t.status === 'waiting') { dropPeer(t, 'denied'); } return { ok: true }; }
    case 'cohost': {
      requireHost(p); const t = targetOf(r, b);
      if (t.role === 'host') throw err(400, 'is-host');
      t.role = b.on ? 'cohost' : (r.meeting.mode === 'webinar' ? 'panelist' : 'participant');
      sendRoster(r); break;
    }
    case 'panelist': {
      if (r.meeting.mode !== 'webinar') throw err(400, 'not-webinar');
      const t = targetOf(r, b);
      if (isMod(t)) throw err(400, 'is-moderator');
      t.role = b.on ? 'panelist' : 'attendee';
      if (!b.on) { t.mic = false; if (r.sharer === t.id) { r.sharer = null; t.screen = null; } }
      sendRoster(r); break;
    }
    case 'spotlight': r.spotlight = b.target && r.peers.has(b.target) ? b.target : null; sendRoom(r); break;
    case 'lower-hand': { const t = targetOf(r, b); t.hand = false; sendRoster(r); break; }
    case 'end':
      requireHost(p);
      for (const t of [...r.peers.values()]) send(t, 'ended', {});
      for (const t of [...r.peers.values()]) { if (t.res) t.res.end(); peers.delete(t.id); }
      rooms.delete(r.id);
      return { ok: true };
    // --- breakout rooms ---
    case 'bo-create': {
      const n = Math.max(1, Math.min(20, Number(b.count) || 2));
      r.breakouts.rooms = Array.from({ length: n }, (_, i) => ({ id: `b${i + 1}`, name: `Room ${i + 1}` }));
      for (const t of r.peers.values()) t.assign = null;
      r.breakouts.open = false;
      sendRoom(r); sendRoster(r); break;
    }
    case 'bo-auto': {
      const rs = r.breakouts.rooms; if (!rs.length) throw err(400, 'no-rooms');
      let i = 0;
      for (const t of r.peers.values()) if (!isMod(t) && t.status === 'in') t.assign = rs[i++ % rs.length].id;
      sendRoster(r); break;
    }
    case 'bo-assign': {
      const t = targetOf(r, b);
      if (b.room && !r.breakouts.rooms.some((x) => x.id === b.room)) throw err(400, 'no-such-room');
      t.assign = b.room || null;
      if (r.breakouts.open && t.status === 'in') move(r, t, t.assign || 'main');
      sendRoster(r); break;
    }
    case 'bo-open':
      if (!r.breakouts.rooms.length) throw err(400, 'no-rooms');
      r.breakouts.open = true;
      for (const t of r.peers.values()) if (t.status === 'in' && t.assign) move(r, t, t.assign);
      sendRoom(r); sendRoster(r); break;
    case 'bo-close':
      r.breakouts.open = false;
      for (const t of r.peers.values()) if (t.channel !== 'main') move(r, t, 'main');
      sendRoom(r); sendRoster(r); break;
    case 'bo-broadcast': {
      const text = String(b.text ?? '').trim().slice(0, 500); if (!text) throw err(400, 'empty');
      for (const t of r.peers.values()) send(t, 'broadcast', { from: p.name, text });
      break;
    }
    case 'bo-join':
      if (!r.breakouts.rooms.some((x) => x.id === b.room) && b.room !== 'main') throw err(400, 'no-such-room');
      move(r, p, b.room); sendRoster(r); break;
    default: throw err(400, 'bad-action');
  }
  return { ok: true };
};

// ---------- http plumbing ----------
function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SEC });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 65536) { reject(err(413, 'too-large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(err(400, 'bad-json')); } });
    req.on('error', reject);
  });
}
const hostFrom = (req) => {
  const h = String(req.headers.host || 'localhost');
  const proto = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  return /^[a-z0-9.:-]+$/i.test(h) ? `${proto}://${h}` : `${proto}://localhost`;
};
const icsDate = (d) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const icsEsc = (s) => String(s).replace(/([\\;,])/g, '\\$1').replace(/\n/g, '\\n');

function createMeeting(b) {
  const mode = b.mode === 'webinar' ? 'webinar' : 'meeting';
  const title = String(b.title ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 120) || (mode === 'webinar' ? 'Webinar' : 'Meeting');
  const startMs = b.instant ? Date.now() : Date.parse(b.start);
  if (Number.isNaN(startMs)) throw err(400, 'bad-start');
  const passcode = String(b.passcode ?? '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 20);
  let id; do { id = meetingCode(); } while (meetings.has(id));
  const m = {
    id, title, mode, start: new Date(startMs).toISOString(),
    duration: Math.max(5, Math.min(720, Number(b.duration) || 60)),
    passcode, waitingRoom: !!b.waitingRoom, hostKey: rid(12), created: Date.now(),
  };
  meetings.set(id, m); saveMeetings();
  return m;
}

async function api(req, res, url) {
  const route = url.pathname;
  if (req.method === 'GET' && route === '/api/config') return json(res, 200, { ice: ICE, reactions: REACTIONS });

  if (req.method === 'POST' && route === '/api/meetings') {
    const m = createMeeting(await readBody(req));
    return json(res, 201, { ...publicMeeting(m), hostKey: m.hostKey });
  }
  let mt = route.match(/^\/api\/meetings\/([a-z]{3}-[a-z]{4}-[a-z]{3})(\/ics)?$/);
  if (req.method === 'GET' && mt) {
    const m = meetings.get(mt[1]);
    if (!m) throw err(404, 'no-meeting');
    if (!mt[2]) return json(res, 200, publicMeeting(m));
    const link = `${hostFrom(req)}/m/${m.id}`;
    const body = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Kestrel Meet//EN', 'BEGIN:VEVENT',
      `UID:${m.id}@kestrel-meet`, `DTSTAMP:${icsDate(Date.now())}`, `DTSTART:${icsDate(m.start)}`,
      `DTEND:${icsDate(Date.parse(m.start) + m.duration * 60000)}`, `SUMMARY:${icsEsc(m.title)}`,
      `DESCRIPTION:${icsEsc(`Join: ${link}${m.passcode ? `\nPasscode: ${m.passcode}` : ''}`)}`, `URL:${link}`,
      'END:VEVENT', 'END:VCALENDAR'].join('\r\n') + '\r\n';
    res.writeHead(200, { 'content-type': 'text/calendar; charset=utf-8', 'content-disposition': `attachment; filename="${m.id}.ics"`, ...SEC });
    return res.end(body);
  }

  if (req.method === 'POST' && route === '/api/join') {
    const b = await readBody(req);
    const m = meetings.get(String(b.meeting));
    if (!m) throw err(404, 'no-meeting');
    const isHost = !!b.hostKey && safeEq(b.hostKey, m.hostKey);
    if (!isHost && m.passcode && !safeEq(String(b.passcode ?? ''), m.passcode)) throw err(403, 'passcode');
    const r = getRoom(m.id);
    if (r.locked && !isHost) throw err(403, 'locked');
    if (r.peers.size >= MAX_PEERS) throw err(403, 'full');
    clearTimeout(r.cleanup);
    const p = {
      id: rid(6), token: rid(16), name: cleanName(b.name) || 'Guest', room: r,
      role: isHost ? 'host' : (m.mode === 'webinar' ? 'attendee' : 'participant'),
      status: !isHost && r.waitingRoom ? 'waiting' : 'in',
      channel: 'main', hand: false, cam: true, mic: true, screen: null, assign: null,
      res: null, chatTimes: [], dropTimer: null,
    };
    if (p.role === 'attendee') { p.cam = false; p.mic = false; }
    r.peers.set(p.id, p); peers.set(p.id, p);
    sendRoster(r);
    return json(res, 200, { peer: p.id, token: p.token, role: p.role, status: p.status, meeting: publicMeeting(m) });
  }

  if (req.method === 'GET' && route === '/api/events') {
    const p = peers.get(url.searchParams.get('peer') || '');
    if (!p || !safeEq(url.searchParams.get('token') || '', p.token)) throw err(401, 'unauthorized');
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no', ...SEC });
    res.write(': ok\n\n');
    clearTimeout(p.dropTimer);
    if (p.res && p.res !== res) p.res.end();
    p.res = res;
    req.on('close', () => {
      if (p.res === res) { p.res = null; p.dropTimer = setTimeout(() => { if (peers.get(p.id) === p) dropPeer(p); }, 10000); }
    });
    const r = p.room;
    send(p, 'hello', {
      you: pub(p), ice: ICE, room: roomPublic(r), chat: histFor(r, p),
      roster: [...r.peers.values()].filter((q) => q.status === 'in' || isMod(p) || q.id === p.id).map(pub),
      polls: p.status === 'in' ? pollsFor(r, p) : [], questions: p.status === 'in' ? r.questions : [],
    });
    for (const [ev, d] of p.queue || []) send(p, ev, d);
    p.queue = [];
    sendRoster(r);
    return;
  }

  const name = route.startsWith('/api/') ? route.slice(5) : '';
  if (req.method === 'POST' && H[name]) {
    const b = await readBody(req);
    const p = peers.get(String(b.peer ?? ''));
    if (!p || !safeEq(String(b.token ?? ''), p.token)) throw err(401, 'unauthorized');
    if (p.status !== 'in' && !['leave', 'state'].includes(name)) throw err(403, 'not-admitted');
    return json(res, 200, H[name](p, p.room, b));
  }
  throw err(404, 'not-found');
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '/schedule' || rel.startsWith('/m/')) rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403, SEC); return res.end('forbidden'); }
  fs.readFile(file, (e, buf) => {
    if (e) { res.writeHead(404, { 'content-type': 'text/plain', ...SEC }); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache', ...SEC });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else if (req.method === 'GET' || req.method === 'HEAD') serveStatic(req, res, url);
    else { res.writeHead(405, SEC); res.end(); }
  } catch (e) {
    if (e instanceof HttpError) { if (!res.headersSent) json(res, e.code, { error: e.message }); }
    else { console.error(e); if (!res.headersSent) json(res, 500, { error: 'server-error' }); }
  }
});
setInterval(() => { for (const p of peers.values()) if (p.res && !p.res.writableEnded) p.res.write(': ka\n\n'); }, 15000).unref();

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(PORT, () => console.log(`Kestrel Meet on http://localhost:${PORT}`));
}
export { server };
