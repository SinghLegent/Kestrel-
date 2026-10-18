import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const FILE = path.join(process.cwd(), 'data', 'meetings.json');
const load = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; } };
const save = (db) => { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(db, null, 1)); };

const L = 'abcdefghijkmnopqrstuvwxyz';
const part = (n) => Array.from({ length: n }, () => L[crypto.randomInt(L.length)]).join('');
export const rid = (n = 12) => crypto.randomBytes(n).toString('hex');
export const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

export function createMeeting(b) {
  const db = load();
  let id; do { id = `${part(3)}-${part(4)}-${part(3)}`; } while (db[id]);
  const mode = b.mode === 'webinar' ? 'webinar' : 'meeting';
  const m = {
    id, mode, hostKey: rid(12), created: Date.now(), locked: false,
    title: String(b.title || (mode === 'webinar' ? 'Webinar' : 'Meeting')).replace(/[<>\u0000-\u001f]/g, '').slice(0, 120),
    start: b.instant ? new Date().toISOString() : new Date(b.start).toISOString(),
    duration: Math.max(5, Math.min(720, Number(b.duration) || 60)),
    passcode: String(b.passcode || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 20),
    waitingRoom: !!b.waitingRoom,
    pending: {},   // identity -> { name, admitted }
    cohosts: [],   // identities
    panelists: [], // identities (webinar)
  };
  db[id] = m; save(db); return m;
}
export const getMeeting = (id) => load()[id] || null;
export function updateMeeting(id, fn) { const db = load(); const m = db[id]; if (!m) return null; fn(m); save(db); return m; }
export const publicMeeting = (m) => ({ id: m.id, title: m.title, mode: m.mode, start: m.start, duration: m.duration, needsPasscode: !!m.passcode, waitingRoom: m.waitingRoom });
