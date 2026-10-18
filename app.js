// Router and the three pre-meeting screens: home, schedule, pre-join.
import { h, clear, api, toast, store, fmtTime, CODE_RE } from './util.js';
import { enterMeeting, getMedia } from './room.js';

const app = document.getElementById('app');
let previewStream = null;
const stopPreview = () => { if (previewStream) previewStream.getTracks().forEach((t) => t.stop()); previewStream = null; };

function nav(path) { history.pushState({}, '', path); route(); }
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-nav]');
  if (a) { e.preventDefault(); nav(a.getAttribute('href')); }
});
window.addEventListener('popstate', route);

const brand = () => h('header', { class: 'brand' }, h('a', { href: '/', 'data-nav': '' }, h('img', { src: '/favicon.svg', alt: '', width: '28', height: '28' }), h('span', {}, 'Kestrel Meet')));
const page = (...kids) => { stopPreview(); clear(app); app.append(h('div', { class: 'page' }, brand(), ...kids)); };
const errText = (e) => ({
  'no-meeting': 'That meeting code does not exist.', passcode: 'The passcode is not right.', locked: 'The host has locked this meeting.',
  full: 'This meeting is full.', 'bad-start': 'Pick a valid start time.',
}[e.message] || 'Something went wrong. Please try again.');

function route() {
  const p = location.pathname;
  const m = p.match(/^\/m\/([a-z]{3}-[a-z]{4}-[a-z]{3})\/?$/i);
  if (m) return preJoin(m[1].toLowerCase());
  if (p === '/schedule') return schedule();
  return home();
}

// ---------- home ----------
async function startNow(mode) {
  try {
    const m = await api('meetings', { instant: true, mode, title: mode === 'webinar' ? 'Instant webinar' : 'Instant meeting' });
    store.save({ id: m.id, title: m.title, mode: m.mode, start: m.start, hostKey: m.hostKey, passcode: '' });
    nav(`/m/${m.id}`);
  } catch (e) { toast(errText(e), 'warn'); }
}

function home() {
  const code = h('input', { type: 'text', id: 'join-code', placeholder: 'Paste a meeting link or code', 'aria-label': 'Meeting link or code', autocomplete: 'off', class: 'grow' });
  const join = () => {
    const mm = code.value.match(CODE_RE);
    if (!mm) return toast('Enter a code like abc-defg-hij or paste the full link.', 'warn');
    nav(`/m/${mm[1].toLowerCase()}`);
  };
  code.addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
  const upcoming = Object.values(store.all()).filter((m) => m.hostKey).sort((a, b) => a.start.localeCompare(b.start));
  const list = h('ul', { class: 'meetings' });
  for (const m of upcoming) {
    list.append(h('li', {}, h('div', {}, h('strong', {}, m.title), h('span', { class: 'chip' }, m.mode === 'webinar' ? 'Webinar' : 'Meeting'), h('div', { class: 'muted' }, `${fmtTime(m.start)} · ${m.id}`)),
      h('div', { class: 'row' },
        h('a', { class: 'btn small', href: `/m/${m.id}`, 'data-nav': '' }, 'Start'),
        h('button', { class: 'btn small', onclick: async () => { try { await navigator.clipboard.writeText(`${location.origin}/m/${m.id}`); toast('Link copied'); } catch { toast(`${location.origin}/m/${m.id}`); } } }, 'Copy link'),
        h('button', { class: 'btn small ghost', 'aria-label': `Forget ${m.title}`, onclick: () => { store.remove(m.id); home(); } }, 'Forget'))));
  }
  page(
    h('section', { class: 'hero' },
      h('h1', {}, 'Video meetings that just work.'),
      h('p', { class: 'lead' }, 'Start a call, run a webinar or split into breakout rooms. No account needed.'),
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn primary big', id: 'new-meeting', onclick: () => startNow('meeting') }, 'New meeting'),
        h('button', { class: 'btn big', id: 'new-webinar', onclick: () => startNow('webinar') }, 'New webinar'),
        h('a', { class: 'btn big', href: '/schedule', 'data-nav': '', id: 'schedule-link' }, 'Schedule'))),
    h('section', { class: 'card' }, h('h2', {}, 'Join a meeting'), h('div', { class: 'row' }, code, h('button', { class: 'btn primary', id: 'join-btn', onclick: join }, 'Join'))),
    upcoming.length ? h('section', { class: 'card' }, h('h2', {}, 'Your meetings'), list) : null,
    h('p', { class: 'muted small-print' }, 'Peer-to-peer calls work best with up to about six cameras. Recordings are saved on the recorder’s own device.'));
}

// ---------- schedule ----------
function schedule() {
  const pad = (n) => String(n).padStart(2, '0');
  const d = new Date(Date.now() + 3600000); d.setMinutes(0, 0, 0);
  const local = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const f = {
    title: h('input', { type: 'text', id: 'sch-title', maxlength: '120', placeholder: 'Weekly sync', required: true }),
    mode: h('select', { id: 'sch-mode' }, h('option', { value: 'meeting' }, 'Meeting'), h('option', { value: 'webinar' }, 'Webinar')),
    start: h('input', { type: 'datetime-local', id: 'sch-start', value: local, required: true }),
    dur: h('input', { type: 'number', id: 'sch-dur', min: '5', max: '720', value: '60' }),
    pass: h('input', { type: 'text', id: 'sch-pass', maxlength: '20', placeholder: 'Optional' }),
    wait: h('input', { type: 'checkbox', id: 'sch-wait' }),
  };
  const out = h('div');
  const field = (label, el, id) => h('label', { class: 'field', for: id }, h('span', {}, label), el);
  const form = h('form', { class: 'card form', onsubmit: async (e) => {
    e.preventDefault();
    try {
      const m = await api('meetings', { title: f.title.value, mode: f.mode.value, start: new Date(f.start.value).toISOString(), duration: Number(f.dur.value), passcode: f.pass.value, waitingRoom: f.wait.checked });
      store.save({ id: m.id, title: m.title, mode: m.mode, start: m.start, hostKey: m.hostKey, passcode: f.pass.value });
      const link = `${location.origin}/m/${m.id}`;
      clear(out).append(h('div', { class: 'card ok', id: 'sch-result' }, h('h2', {}, 'Scheduled'),
        h('p', {}, h('strong', {}, m.title), ` · ${fmtTime(m.start)}`),
        h('p', {}, 'Link: ', h('code', { id: 'sch-link' }, link)),
        m.needsPasscode ? h('p', {}, 'Passcode: ', h('code', {}, f.pass.value.replace(/[^a-zA-Z0-9]/g, ''))) : null,
        h('div', { class: 'row wrap' },
          h('button', { type: 'button', class: 'btn', onclick: async () => { try { await navigator.clipboard.writeText(link); toast('Invite link copied'); } catch { toast(link); } } }, 'Copy invite'),
          h('a', { class: 'btn', href: `/api/meetings/${m.id}/ics`, id: 'sch-ics', download: '' }, 'Add to calendar (.ics)'),
          h('a', { class: 'btn primary', href: `/m/${m.id}`, 'data-nav': '' }, 'Open meeting'))));
    } catch (er) { toast(errText(er), 'warn'); }
  } },
  h('h2', {}, 'Schedule a meeting'),
  field('Title', f.title, 'sch-title'), field('Type', f.mode, 'sch-mode'), field('Start', f.start, 'sch-start'),
  field('Duration (minutes)', f.dur, 'sch-dur'), field('Passcode', f.pass, 'sch-pass'),
  h('label', { class: 'toggle' }, f.wait, h('span', {}, 'Use a waiting room')),
  h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit', id: 'sch-submit' }, 'Schedule'), h('a', { class: 'btn ghost', href: '/', 'data-nav': '' }, 'Cancel')));
  page(form, out);
}

// ---------- pre-join ----------
async function preJoin(code) {
  let meeting;
  try { meeting = await api(`meetings/${code}`); } catch (e) {
    return page(h('div', { class: 'card center' }, h('h2', {}, errText(e)), h('a', { class: 'btn primary', href: '/', 'data-nav': '' }, 'Home')));
  }
  const saved = store.get(code);
  const hostKey = saved && saved.hostKey;
  const attendeeOnly = meeting.mode === 'webinar' && !hostKey;
  const prefs = { mic: true, cam: true, audioId: '', videoId: '' };
  const name = h('input', { type: 'text', id: 'pj-name', maxlength: '40', placeholder: 'Your name', value: store.name(), autocomplete: 'name', 'aria-label': 'Your name' });
  const pass = meeting.needsPasscode && !hostKey ? h('input', { type: 'text', id: 'pj-pass', placeholder: 'Passcode', 'aria-label': 'Passcode', autocomplete: 'off' }) : null;
  const video = h('video', { autoplay: true, playsInline: true, muted: true, class: 'preview-video' });
  const note = h('p', { class: 'muted' }, '');
  const micSel = h('select', { 'aria-label': 'Microphone', id: 'pj-mic' }), camSel = h('select', { 'aria-label': 'Camera', id: 'pj-cam' });
  const micTgl = h('input', { type: 'checkbox', checked: true, id: 'pj-mic-on' }), camTgl = h('input', { type: 'checkbox', checked: true, id: 'pj-cam-on' });

  async function startPreview() {
    stopPreview();
    if (attendeeOnly) return;
    previewStream = await getMedia({ mic: micTgl.checked, cam: camTgl.checked, audioId: micSel.value, videoId: camSel.value });
    video.srcObject = previewStream;
    note.textContent = previewStream ? '' : 'No camera or microphone available. You can still join and listen.';
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      const fill = (sel, kind) => {
        const cur = sel.value; clear(sel);
        devs.filter((d) => d.kind === kind).forEach((d, i) => sel.append(h('option', { value: d.deviceId, selected: d.deviceId === cur }, d.label || `${kind === 'audioinput' ? 'Microphone' : 'Camera'} ${i + 1}`)));
      };
      fill(micSel, 'audioinput'); fill(camSel, 'videoinput');
    } catch { /* ignore */ }
  }
  micSel.addEventListener('change', startPreview); camSel.addEventListener('change', startPreview);
  micTgl.addEventListener('change', () => { if (previewStream) previewStream.getAudioTracks().forEach((t) => { t.enabled = micTgl.checked; }); });
  camTgl.addEventListener('change', () => { if (previewStream) previewStream.getVideoTracks().forEach((t) => { t.enabled = camTgl.checked; }); });

  const err = h('p', { class: 'error', role: 'alert' }, '');
  const joinBtn = h('button', { class: 'btn primary big', id: 'pj-join' }, hostKey ? 'Start meeting' : 'Join now');
  joinBtn.addEventListener('click', async () => {
    const nm = name.value.trim();
    if (!nm) { err.textContent = 'Please enter your name.'; name.focus(); return; }
    joinBtn.disabled = true; err.textContent = '';
    try {
      const session = await api('join', { meeting: code, name: nm, passcode: pass ? pass.value : '', hostKey });
      store.setName(nm);
      let local = previewStream; previewStream = null;
      if (local && !micTgl.checked) local.getAudioTracks().forEach((t) => { t.enabled = false; });
      if (local && !camTgl.checked) local.getVideoTracks().forEach((t) => { t.enabled = false; });
      if (session.role === 'attendee' && local) { local.getTracks().forEach((t) => t.stop()); local = null; }
      if (!local && session.role !== 'attendee') local = await getMedia({});
      await enterMeeting({ session, localStream: local, meeting });
    } catch (e) { err.textContent = errText(e); joinBtn.disabled = false; }
  });

  page(h('div', { class: 'prejoin' },
    h('div', { class: 'card' }, h('h1', {}, meeting.title), h('p', { class: 'muted' }, `${meeting.mode === 'webinar' ? 'Webinar' : 'Meeting'} · ${meeting.id}${meeting.start ? ' · ' + fmtTime(meeting.start) : ''}`),
      attendeeOnly ? h('p', {}, 'You are joining as an attendee. You can watch, chat, vote in polls and ask questions.') : h('div', { class: 'preview' }, video, note,
        h('div', { class: 'row wrap' }, h('label', { class: 'toggle' }, micTgl, h('span', {}, 'Microphone on')), h('label', { class: 'toggle' }, camTgl, h('span', {}, 'Camera on'))),
        h('div', { class: 'row wrap' }, micSel, camSel)),
      h('label', { class: 'field', for: 'pj-name' }, h('span', {}, 'Your name'), name),
      pass ? h('label', { class: 'field', for: 'pj-pass' }, h('span', {}, 'Passcode'), pass) : null,
      err, h('div', { class: 'row' }, joinBtn, h('a', { class: 'btn ghost', href: '/', 'data-nav': '' }, 'Back')))));
  startPreview();
}

route();
