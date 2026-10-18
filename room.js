// The meeting room: media tiles, controls, side panels, moderation, polls, Q&A,
// breakout rooms and local recording. The server enforces every permission;
// this file only reflects it.
import { h, clear, api, toast } from './util.js';
import { Mesh } from './rtc.js';

export async function getMedia(prefs = {}) {
  const base = {
    audio: prefs.mic === false ? false : (prefs.audioId ? { deviceId: { exact: prefs.audioId } } : true),
    video: prefs.cam === false ? false : (prefs.videoId ? { deviceId: { exact: prefs.videoId }, width: 1280, height: 720 } : { width: 1280, height: 720 }),
  };
  try { return await navigator.mediaDevices.getUserMedia(base); } catch { /* fall through */ }
  try { return await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { return null; }
}

export async function enterMeeting({ session, localStream, meeting }) {
  const app = document.getElementById('app');
  clear(app);
  const S = {
    me: { id: session.peer, name: '', role: session.role, status: session.status, channel: 'main', cam: true, mic: true },
    room: { title: meeting.title, mode: meeting.mode, perms: {}, breakouts: { rooms: [] } },
    roster: [], chat: [], polls: [], questions: [],
    streams: new Map(), local: localStream, screen: null,
    pinned: null, panel: null, unread: {}, speaking: new Set(), analysers: new Map(),
    tiles: new Map(), rec: null, ended: false,
  };
  const auth = () => ({ peer: session.peer, token: session.token });
  const call = (path, body = {}) => api(path, { ...auth(), ...body });
  const isMod = (p = S.me) => p.role === 'host' || p.role === 'cohost';
  const canSpeak = (p = S.me) => p.role !== 'attendee';
  const webinar = () => S.room.mode === 'webinar';
  const byId = (id) => S.roster.find((p) => p.id === id);

  if (S.local) {
    S.me.cam = S.local.getVideoTracks().some((t) => t.enabled);
    S.me.mic = S.local.getAudioTracks().some((t) => t.enabled);
  } else { S.me.cam = false; S.me.mic = false; }

  const actx = new (window.AudioContext || window.webkitAudioContext)();
  actx.resume().catch(() => {});

  // ---------- mesh ----------
  const mesh = new Mesh({
    meId: session.peer, ice: [],
    signal: (to, data) => call('signal', { to, data }).catch(() => {}),
    onStream: (peerId, stream) => addStream(peerId, stream),
    onGone: (peerId) => { S.streams.delete(peerId); renderStage(); },
  });
  mesh.setLocal(S.local);

  function addStream(peerId, stream) {
    let m = S.streams.get(peerId);
    if (!m) { m = new Map(); S.streams.set(peerId, m); }
    if (!m.has(stream.id)) {
      m.set(stream.id, stream);
      stream.addEventListener('removetrack', () => {
        if (stream.getTracks().length === 0) { m.delete(stream.id); renderStage(); }
      });
      if (S.rec) S.rec.addAudio(stream);
    }
    renderStage();
  }

  function syncMesh() {
    if (S.me.status !== 'in') { mesh.sync([]); return; }
    const targets = S.roster
      .filter((p) => p.id !== S.me.id && p.status === 'in' && p.channel === S.me.channel && (canSpeak(p) || canSpeak(S.me)))
      .map((p) => ({ id: p.id, kind: (canSpeak(S.me) ? 's' : 'r') + (canSpeak(p) ? 's' : 'r') }));
    mesh.sync(targets);
    if (targets.length > 6 && !S.warnedMesh) { S.warnedMesh = true; toast('Large call: video quality may drop beyond about 6 people in this peer-to-peer build.', 'warn'); }
  }

  // ---------- DOM skeleton ----------
  const els = {};
  const dot = (cls) => h('span', { class: `dot ${cls}` });
  els.title = h('h1', { class: 'room-title' }, meeting.title);
  els.rec = h('span', { class: 'rec-badge', hidden: true }, '');
  els.count = h('span', { class: 'muted' }, '');
  els.stage = h('div', { class: 'stage' });
  els.banner = h('div', { class: 'banner', hidden: true });
  els.reactions = h('div', { class: 'reactions-layer', 'aria-hidden': 'true' });
  els.waiting = h('div', { class: 'overlay', hidden: true }, h('div', { class: 'card center' },
    h('h2', {}, 'Waiting for the host'),
    h('p', { class: 'muted' }, 'You will join as soon as the host lets you in.'),
    h('button', { class: 'btn danger', onclick: () => leave() }, 'Leave')));
  els.ended = h('div', { class: 'overlay', hidden: true });
  els.controls = h('div', { class: 'controls', role: 'toolbar', 'aria-label': 'Meeting controls' });
  els.panelWrap = h('aside', { class: 'panel', hidden: true, 'aria-label': 'Side panel' });
  els.tabs = h('div', { class: 'tabs', role: 'tablist' });
  els.panelBody = h('div', { class: 'panel-body' });
  els.panelWrap.append(els.tabs, els.panelBody);

  const link = `${location.origin}/m/${meeting.id}`;
  const topbar = h('header', { class: 'topbar' },
    h('div', { class: 'row' }, els.title, h('span', { class: 'code' }, meeting.id), els.rec),
    h('div', { class: 'row' }, els.count,
      h('button', { class: 'btn ghost', onclick: async () => { try { await navigator.clipboard.writeText(link); toast('Invite link copied'); } catch { toast(link); } } }, 'Copy invite link')));
  app.append(h('div', { class: 'room' }, topbar, els.banner,
    h('div', { class: 'main' }, h('div', { class: 'stage-wrap' }, els.stage, els.reactions), els.panelWrap),
    els.controls, els.waiting, els.ended));

  // ---------- tiles ----------
  const initial = (n) => (n || '?').trim().charAt(0).toUpperCase() || '?';
  function makeTile(key) {
    const video = h('video', { autoplay: true, playsInline: true });
    const avatar = h('div', { class: 'avatar' }, '?');
    const label = h('div', { class: 'label' });
    const badges = h('div', { class: 'badges' });
    const el = h('div', { class: 'tile', 'data-key': key, tabindex: '0' }, video, avatar, label, badges);
    el.addEventListener('click', () => { S.pinned = S.pinned === key ? null : key; renderStage(); });
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.click(); });
    return { el, video, avatar, label, badges };
  }
  function camStreamOf(p) {
    if (p.id === S.me.id) return S.local;
    const m = S.streams.get(p.id); if (!m) return null;
    for (const s of m.values()) if (s.id !== p.screen) return s;
    return null;
  }
  function screenStreamOf(p) {
    if (!p.screen) return null;
    if (p.id === S.me.id) return S.screen;
    const m = S.streams.get(p.id); return m ? m.get(p.screen) || null : null;
  }
  function roleLabel(p) { return { host: 'Host', cohost: 'Co-host', panelist: 'Panelist' }[p.role] || ''; }

  function renderStage() {
    if (S.ended) return;
    const inCh = S.roster.filter((p) => p.status === 'in' && p.channel === S.me.channel);
    const shown = inCh.filter((p) => !webinar() || p.role !== 'attendee');
    const want = [];
    for (const p of shown) {
      want.push({ key: `cam:${p.id}`, p, kind: 'cam' });
      if (screenStreamOf(p)) want.push({ key: `scr:${p.id}`, p, kind: 'scr' });
    }
    const keys = new Set(want.map((w) => w.key));
    for (const [k, t] of [...S.tiles]) if (!keys.has(k)) { t.el.remove(); S.tiles.delete(k); }
    if (S.pinned && !keys.has(S.pinned)) S.pinned = null;
    const spot = S.room.spotlight && keys.has(`cam:${S.room.spotlight}`) ? `cam:${S.room.spotlight}` : null;
    const sharing = want.find((w) => w.kind === 'scr');
    const main = S.pinned || (sharing && sharing.key) || spot;
    els.stage.className = `stage ${main ? 'focus' : 'grid'}`;
    els.stage.style.setProperty('--cols', String(want.length <= 1 ? 1 : want.length <= 4 ? 2 : want.length <= 9 ? 3 : 4));
    els.stage.style.setProperty('--rows', String(Math.max(4, want.length - 1)));

    want.forEach((w, i) => {
      let t = S.tiles.get(w.key);
      if (!t) { t = makeTile(w.key); S.tiles.set(w.key, t); els.stage.append(t.el); }
      const p = w.p, isMe = p.id === S.me.id;
      const stream = w.kind === 'scr' ? screenStreamOf(p) : camStreamOf(p);
      if (t.video.srcObject !== stream) { t.video.srcObject = stream; t.video.play().catch(() => {}); }
      t.video.muted = isMe;
      const camOn = w.kind === 'scr' || (p.cam && stream && stream.getVideoTracks().length > 0);
      t.el.classList.toggle('nocam', !camOn);
      t.el.classList.toggle('main', w.key === main);
      t.el.classList.toggle('mirror', isMe && w.kind === 'cam');
      t.el.style.order = w.key === main ? '-1' : String(i);
      t.avatar.textContent = initial(p.name);
      t.label.textContent = (w.kind === 'scr' ? `${p.name}'s screen` : p.name + (isMe ? ' (You)' : '')) + (roleLabel(p) && w.kind === 'cam' ? ` · ${roleLabel(p)}` : '');
      clear(t.badges);
      if (w.kind === 'cam') {
        if (!p.mic) t.badges.append(h('span', { class: 'badge', title: 'Muted' }, '🔇'));
        if (p.hand) t.badges.append(h('span', { class: 'badge', title: 'Hand raised' }, '✋'));
      }
      t.el.dataset.peer = p.id;
    });
    const attendees = inCh.length - shown.length;
    els.count.textContent = `${inCh.length} in ${S.me.channel === 'main' ? 'meeting' : 'breakout room'}` + (webinar() && attendees ? ` · ${attendees} attending` : '');
    markSpeaking();
  }

  // ---------- speaking detection ----------
  function analyser(stream) {
    if (S.analysers.has(stream.id)) return S.analysers.get(stream.id);
    if (!stream.getAudioTracks().length) return null;
    try {
      const a = actx.createAnalyser(); a.fftSize = 256;
      actx.createMediaStreamSource(new MediaStream(stream.getAudioTracks())).connect(a);
      const rec = { a, buf: new Uint8Array(a.frequencyBinCount) };
      S.analysers.set(stream.id, rec); return rec;
    } catch { return null; }
  }
  function level(stream) {
    const r = stream && analyser(stream); if (!r) return 0;
    r.a.getByteFrequencyData(r.buf);
    let s = 0; for (const v of r.buf) s += v; return s / r.buf.length;
  }
  function markSpeaking() {
    for (const [key, t] of S.tiles) t.el.classList.toggle('speaking', S.speaking.has(key));
  }
  const speakTimer = setInterval(() => {
    const next = new Set();
    for (const p of S.roster) {
      if (p.status !== 'in' || p.channel !== S.me.channel || !p.mic) continue;
      const st = camStreamOf(p);
      if (st && level(st) > 10) next.add(`cam:${p.id}`);
    }
    if (next.size !== S.speaking.size || [...next].some((k) => !S.speaking.has(k))) { S.speaking = next; markSpeaking(); }
  }, 300);

  // ---------- controls ----------
  function ctl(label, icon, onclick, opts = {}) {
    return h('button', { class: `ctl ${opts.on ? 'on' : ''} ${opts.danger ? 'danger' : ''}`, onclick, 'aria-pressed': opts.pressed == null ? null : String(opts.pressed), title: opts.title || label, disabled: opts.disabled, 'data-ctl': opts.id || label.toLowerCase().replace(/\W+/g, '-') },
      h('span', { class: 'ico', 'aria-hidden': 'true' }, icon), h('span', {}, label));
  }
  function renderControls() {
    clear(els.controls);
    const me = S.me;
    if (canSpeak()) {
      const hasA = S.local && S.local.getAudioTracks().length > 0;
      const hasV = S.local && S.local.getVideoTracks().length > 0;
      els.controls.append(
        ctl(me.mic ? 'Mute' : 'Unmute', me.mic ? '🎙️' : '🔇', () => setMic(!me.mic), { pressed: !me.mic, disabled: !hasA, id: 'mic', title: hasA ? '' : 'No microphone' }),
        ctl(me.cam ? 'Stop video' : 'Start video', me.cam ? '📹' : '🚫', () => setCam(!me.cam), { pressed: !me.cam, disabled: !hasV, id: 'cam', title: hasV ? '' : 'No camera' }),
        ctl(S.screen ? 'Stop share' : 'Share', '🖥️', toggleShare, { on: !!S.screen, id: 'share' }));
    }
    els.controls.append(
      ctl(me.hand ? 'Lower hand' : 'Raise hand', '✋', () => call('hand', { on: !me.hand }).catch(() => {}), { on: me.hand, id: 'hand' }),
      reactionsBtn(),
      ctl('Chat', '💬', () => togglePanel('chat'), { on: S.panel === 'chat', id: 'chat' }),
      ctl('People', '👥', () => togglePanel('people'), { on: S.panel === 'people', id: 'people' }),
      ctl('Polls', '📊', () => togglePanel('polls'), { on: S.panel === 'polls', id: 'polls' }));
    if (webinar()) els.controls.append(ctl('Q&A', '❓', () => togglePanel('qa'), { on: S.panel === 'qa', id: 'qa' }));
    if (isMod()) {
      els.controls.append(
        ctl(S.rec ? 'Stop recording' : 'Record', '⏺️', toggleRecord, { on: !!S.rec, id: 'record' }),
        ctl('Security', '🛡️', () => togglePanel('security'), { on: S.panel === 'security', id: 'security' }));
      if (!webinar()) els.controls.append(ctl('Breakouts', '🧩', () => togglePanel('breakouts'), { on: S.panel === 'breakouts', id: 'breakouts' }));
    }
    if (me.channel !== 'main') {
      els.controls.append(ctl('Ask for help', '🆘', () => call('help').then(() => toast('Host notified')).catch(() => {}), { id: 'help' }),
        ctl('Leave room', '↩️', () => (isMod() ? call('host', { action: 'bo-join', room: 'main' }) : call('channel', { to: 'main' })).catch(() => {}), { id: 'leave-room' }));
    }
    if (me.role === 'host') els.controls.append(ctl('End for all', '⛔', () => { if (confirm('End the meeting for everyone?')) call('host', { action: 'end' }).catch(() => {}); }, { danger: true, id: 'end' }));
    els.controls.append(ctl('Leave', '🚪', () => leave(), { danger: true, id: 'leave' }));
  }
  function reactionsBtn() {
    const wrap = h('div', { class: 'pop-wrap' });
    const pop = h('div', { class: 'pop', hidden: true });
    for (const e of (S.emojis || ['👍', '👏', '❤️', '😂', '🎉', '😮'])) {
      pop.append(h('button', { class: 'emoji', onclick: () => { call('reaction', { emoji: e }).catch(() => {}); pop.hidden = true; }, 'aria-label': `React ${e}` }, e));
    }
    wrap.append(ctl('React', '😀', () => { pop.hidden = !pop.hidden; }, { id: 'react' }), pop);
    return wrap;
  }

  function setMic(on) {
    if (!S.local) return;
    S.local.getAudioTracks().forEach((t) => { t.enabled = on; });
    S.me.mic = on; call('state', { mic: on }).catch(() => {}); renderControls(); renderStage();
  }
  function setCam(on) {
    if (!S.local) return;
    S.local.getVideoTracks().forEach((t) => { t.enabled = on; });
    S.me.cam = on; call('state', { cam: on }).catch(() => {}); renderControls(); renderStage();
  }
  async function toggleShare() {
    if (S.screen) return stopShare();
    let st;
    try { st = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }); } catch { return; }
    try { await call('state', { screen: st.id }); } catch (e) {
      st.getTracks().forEach((t) => t.stop());
      toast(e.message === 'someone-sharing' ? 'Someone else is already sharing.' : 'Screen sharing is turned off by the host.', 'warn');
      return;
    }
    S.screen = st; mesh.setScreen(st);
    st.getVideoTracks()[0].addEventListener('ended', stopShare);
    renderControls(); renderStage();
  }
  function stopShare() {
    if (!S.screen) return;
    S.screen.getTracks().forEach((t) => t.stop());
    S.screen = null; mesh.setScreen(null);
    call('state', { screen: null }).catch(() => {});
    renderControls(); renderStage();
  }

  // ---------- panels ----------
  const P = {}; // persistent panel nodes
  function togglePanel(name) {
    S.panel = S.panel === name ? null : name;
    S.unread[name] = 0;
    renderPanel(); renderControls();
  }
  function tabList() {
    const t = [['chat', 'Chat'], ['people', 'People'], ['polls', 'Polls']];
    if (webinar()) t.push(['qa', 'Q&A']);
    if (isMod()) { if (!webinar()) t.push(['breakouts', 'Breakouts']); t.push(['security', 'Security']); }
    return t;
  }
  function renderPanel() {
    els.panelWrap.hidden = !S.panel;
    if (!S.panel) return;
    clear(els.tabs);
    for (const [id, name] of tabList()) {
      els.tabs.append(h('button', { class: `tab ${S.panel === id ? 'on' : ''}`, role: 'tab', onclick: () => { S.panel = id; S.unread[id] = 0; renderPanel(); renderControls(); } },
        name, S.unread[id] ? h('span', { class: 'pill' }, S.unread[id]) : null));
    }
    clear(els.panelBody);
    const build = { chat: panelChat, people: panelPeople, polls: panelPolls, qa: panelQA, breakouts: panelBreakouts, security: panelSecurity }[S.panel];
    if (build) els.panelBody.append(build());
  }
  const refresh = (name) => { if (S.panel === name) renderPanel(); else if (name !== 'people') { S.unread[name] = (S.unread[name] || 0) + 1; renderPanelTabsOnly(); } };
  function renderPanelTabsOnly() { if (S.panel) renderPanel(); }

  // chat
  P.chatInput = h('input', { type: 'text', maxlength: '2000', placeholder: 'Message', 'aria-label': 'Chat message', class: 'grow' });
  P.chatTo = h('select', { 'aria-label': 'Send to' });
  function panelChat() {
    const log = h('div', { class: 'log', 'data-log': 'chat' });
    for (const m of S.chat) {
      const priv = m.to !== 'all';
      log.append(h('div', { class: `msg ${m.from === S.me.id ? 'mine' : ''}` },
        h('div', { class: 'meta' }, m.name + (m.from === S.me.id ? ' (You)' : ''), priv ? ` · private${m.from === S.me.id ? ` to ${(byId(m.to) || {}).name || '?'}` : ''}` : '', ' · ', new Date(m.ts).toLocaleTimeString([], { timeStyle: 'short' })),
        h('div', { class: 'text' }, m.text)));
    }
    queueMicrotask(() => { log.scrollTop = log.scrollHeight; });
    const prev = P.chatTo.value;
    clear(P.chatTo);
    P.chatTo.append(h('option', { value: 'all' }, 'Everyone'));
    for (const p of S.roster) if (p.id !== S.me.id && p.status === 'in' && (p.channel === S.me.channel)) P.chatTo.append(h('option', { value: p.id }, p.name));
    P.chatTo.value = [...P.chatTo.options].some((o) => o.value === prev) ? prev : 'all';
    const send = async () => {
      const text = P.chatInput.value.trim(); if (!text) return;
      try { await call('chat', { text, to: P.chatTo.value }); P.chatInput.value = ''; } catch (e) { toast(e.message === 'chat-blocked' ? 'Chat is turned off by the host.' : e.message === 'slow-down' ? 'Slow down a little.' : 'Could not send.', 'warn'); }
    };
    P.chatInput.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); send(); } };
    const disabled = !(isMod() || S.room.perms.chat);
    P.chatInput.disabled = disabled; P.chatInput.placeholder = disabled ? 'Chat is turned off' : 'Message';
    return h('div', { class: 'col fill' }, log, h('div', { class: 'compose' }, P.chatTo, h('div', { class: 'row' }, P.chatInput, h('button', { class: 'btn primary', onclick: send, disabled }, 'Send'))));
  }

  // people
  function peerActions(p) {
    const acts = [];
    const add = (label, action, extra = {}) => acts.push(h('button', { class: 'btn small', 'data-act': action, onclick: () => call('host', { action, target: p.id, ...extra }).catch((e) => toast(e.message, 'warn')) }, label));
    if (!isMod() || p.id === S.me.id) return acts;
    if (p.status === 'waiting') { add('Admit', 'admit'); add('Deny', 'deny'); return acts; }
    if (p.role !== 'attendee') add('Mute', 'mute');
    if (p.hand) add('Lower hand', 'lower-hand');
    add(S.room.spotlight === p.id ? 'Remove spotlight' : 'Spotlight', 'spotlight', { target: S.room.spotlight === p.id ? null : p.id });
    if (S.me.role === 'host' && p.role !== 'host') add(p.role === 'cohost' ? 'Remove co-host' : 'Make co-host', 'cohost', { on: p.role !== 'cohost' });
    if (webinar() && p.role === 'attendee') add('Promote to panelist', 'panelist', { on: true });
    if (webinar() && p.role === 'panelist') add('Move to attendees', 'panelist', { on: false });
    if (p.role !== 'host' && !(p.role === 'cohost' && S.me.role !== 'host')) add('Remove', 'remove');
    return acts;
  }
  function panelPeople() {
    const root = h('div', { class: 'col fill scroll' });
    const waiting = S.roster.filter((p) => p.status === 'waiting');
    if (isMod() && waiting.length) {
      root.append(h('h3', {}, `Waiting room (${waiting.length})`),
        h('button', { class: 'btn small', onclick: () => call('host', { action: 'admit-all' }).catch(() => {}) }, 'Admit all'));
      for (const p of waiting) root.append(h('div', { class: 'person', 'data-peer': p.id }, h('div', { class: 'row between' }, h('strong', {}, p.name)), h('div', { class: 'row wrap' }, peerActions(p))));
    }
    const inRoom = S.roster.filter((p) => p.status === 'in');
    root.append(h('h3', {}, `In the ${webinar() ? 'webinar' : 'meeting'} (${inRoom.length})`));
    for (const p of inRoom) {
      const where = p.channel === 'main' ? '' : ` · ${(S.room.breakouts.rooms.find((r) => r.id === p.channel) || {}).name || p.channel}`;
      root.append(h('div', { class: 'person', 'data-peer': p.id },
        h('div', { class: 'row between' }, h('span', {}, h('strong', {}, p.name + (p.id === S.me.id ? ' (You)' : '')), h('span', { class: 'muted' }, ` ${roleLabel(p) || (p.role === 'attendee' ? 'Attendee' : '')}${where}`)),
          h('span', {}, p.hand ? '✋ ' : '', p.role !== 'attendee' ? (p.mic ? '🎙️' : '🔇') : '')),
        isMod() && p.id !== S.me.id ? h('div', { class: 'row wrap' }, peerActions(p)) : null));
    }
    if (isMod()) root.append(h('div', { class: 'row wrap top' }, h('button', { class: 'btn', onclick: () => call('host', { action: 'mute-all' }).catch(() => {}) }, 'Mute all')));
    return root;
  }

  // polls
  P.pollQ = h('input', { type: 'text', maxlength: '200', placeholder: 'Poll question', 'aria-label': 'Poll question' });
  P.pollO = h('textarea', { rows: '3', placeholder: 'One option per line (2 to 10)', 'aria-label': 'Poll options' });
  function panelPolls() {
    const root = h('div', { class: 'col fill scroll' });
    if (isMod()) {
      root.append(h('div', { class: 'card tight' }, h('h3', {}, 'New poll'), P.pollQ, P.pollO,
        h('button', { class: 'btn primary', 'data-act': 'poll-create', onclick: async () => {
          const options = P.pollO.value.split('\n').map((s) => s.trim()).filter(Boolean);
          try { await call('poll', { action: 'create', question: P.pollQ.value, options }); P.pollQ.value = ''; P.pollO.value = ''; } catch { toast('A poll needs a question and at least two options.', 'warn'); }
        } }, 'Launch poll')));
    }
    if (!S.polls.length) root.append(h('p', { class: 'muted' }, 'No polls yet.'));
    for (const po of [...S.polls].reverse()) {
      const total = po.counts.reduce((a, b) => a + b, 0);
      const card = h('div', { class: 'card tight', 'data-poll': po.id }, h('strong', {}, po.question), h('span', { class: 'muted' }, po.open ? ' · open' : ' · closed'));
      po.options.forEach((o, i) => {
        const pct = total ? Math.round((po.counts[i] / total) * 100) : 0;
        card.append(h('button', { class: `opt ${po.mine === i ? 'mine' : ''}`, disabled: !po.open, 'data-opt': String(i), onclick: () => call('vote', { id: po.id, option: i }).catch(() => {}) },
          h('span', { class: 'bar', style: `width:${pct}%` }), h('span', { class: 'opt-text' }, o), h('span', { class: 'opt-n' }, `${po.counts[i]} (${pct}%)`)));
      });
      if (isMod() && po.open) card.append(h('button', { class: 'btn small', onclick: () => call('poll', { action: 'close', id: po.id }).catch(() => {}) }, 'Close poll'));
      root.append(card);
    }
    return root;
  }

  // Q&A
  P.qaInput = h('input', { type: 'text', maxlength: '500', placeholder: 'Ask a question', 'aria-label': 'Question', class: 'grow' });
  function panelQA() {
    const root = h('div', { class: 'col fill' });
    const list = h('div', { class: 'log scroll', 'data-log': 'qa' });
    for (const q of S.questions) {
      const box = h('div', { class: 'card tight', 'data-q': q.id }, h('div', { class: 'meta' }, q.name), h('div', {}, q.text),
        q.answer ? h('div', { class: 'answer' }, `${q.answeredBy}: ${q.answer}`) : null);
      if ((isMod() || S.me.role === 'panelist') && !q.answer) {
        const inp = h('input', { type: 'text', placeholder: 'Answer', 'aria-label': 'Answer', class: 'grow' });
        box.append(h('div', { class: 'row' }, inp, h('button', { class: 'btn small', onclick: () => call('answer', { id: q.id, text: inp.value }).catch(() => {}) }, 'Answer')));
      }
      list.append(box);
    }
    if (!S.questions.length) list.append(h('p', { class: 'muted' }, 'No questions yet.'));
    const ask = async () => { const t = P.qaInput.value.trim(); if (!t) return; try { await call('question', { text: t }); P.qaInput.value = ''; } catch { toast('Could not send your question.', 'warn'); } };
    P.qaInput.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); ask(); } };
    root.append(list, h('div', { class: 'compose' }, h('div', { class: 'row' }, P.qaInput, h('button', { class: 'btn primary', onclick: ask }, 'Ask'))));
    return root;
  }

  // breakouts
  P.boCount = h('input', { type: 'number', min: '1', max: '20', value: '2', 'aria-label': 'Number of rooms', class: 'num' });
  P.boMsg = h('input', { type: 'text', maxlength: '500', placeholder: 'Message to all rooms', 'aria-label': 'Broadcast message', class: 'grow' });
  function panelBreakouts() {
    const root = h('div', { class: 'col fill scroll' });
    const b = S.room.breakouts;
    root.append(h('div', { class: 'card tight' }, h('h3', {}, 'Rooms'),
      h('div', { class: 'row' }, P.boCount, h('button', { class: 'btn', 'data-act': 'bo-create', onclick: () => call('host', { action: 'bo-create', count: Number(P.boCount.value) }).catch(() => {}) }, 'Create rooms'))));
    if (b.rooms.length) {
      root.append(h('div', { class: 'row wrap' },
        h('button', { class: 'btn', 'data-act': 'bo-auto', onclick: () => call('host', { action: 'bo-auto' }).catch(() => {}) }, 'Assign automatically'),
        b.open ? h('button', { class: 'btn danger', 'data-act': 'bo-close', onclick: () => call('host', { action: 'bo-close' }).catch(() => {}) }, 'Close all rooms')
          : h('button', { class: 'btn primary', 'data-act': 'bo-open', onclick: () => call('host', { action: 'bo-open' }).catch(() => {}) }, 'Open rooms')));
      for (const r of b.rooms) {
        const members = S.roster.filter((p) => p.assign === r.id);
        root.append(h('div', { class: 'card tight', 'data-room': r.id }, h('div', { class: 'row between' }, h('strong', {}, `${r.name} (${members.length})`),
          b.open ? h('button', { class: 'btn small', onclick: () => call('host', { action: 'bo-join', room: r.id }).catch(() => {}) }, 'Join') : null),
        h('div', { class: 'muted' }, members.map((m) => m.name).join(', ') || 'Nobody assigned')));
      }
      root.append(h('h3', {}, 'Assign people'));
      for (const p of S.roster.filter((x) => x.status === 'in' && !isMod(x))) {
        const sel = h('select', { 'aria-label': `Room for ${p.name}`, 'data-assign': p.id, onchange: () => call('host', { action: 'bo-assign', target: p.id, room: sel.value || null }).catch(() => {}) },
          h('option', { value: '' }, 'Main room'), ...b.rooms.map((r) => h('option', { value: r.id, selected: p.assign === r.id }, r.name)));
        root.append(h('div', { class: 'row between' }, h('span', {}, p.name), sel));
      }
      root.append(h('div', { class: 'row top' }, P.boMsg, h('button', { class: 'btn', onclick: () => { call('host', { action: 'bo-broadcast', text: P.boMsg.value }).then(() => { P.boMsg.value = ''; }).catch(() => {}); } }, 'Broadcast')));
    }
    return root;
  }

  // security
  function toggleRow(label, on, onchange, id) {
    return h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: on, 'data-toggle': id, onchange: (e) => onchange(e.target.checked) }), h('span', {}, label));
  }
  function panelSecurity() {
    const r = S.room;
    const set = (action, extra) => (v) => call('host', { action, ...extra, on: v }).catch((e) => toast(e.message, 'warn'));
    return h('div', { class: 'col fill scroll' },
      h('h3', {}, 'Meeting security'),
      toggleRow('Lock meeting', !!r.locked, set('lock'), 'lock'),
      toggleRow('Waiting room', !!r.waitingRoom, set('waiting'), 'waiting'),
      h('h3', {}, 'Allow participants to'),
      toggleRow('Share screen', !!r.perms.share, set('perm', { key: 'share' }), 'perm-share'),
      toggleRow('Chat', !!r.perms.chat, set('perm', { key: 'chat' }), 'perm-chat'),
      toggleRow('Rename themselves', !!r.perms.rename, set('perm', { key: 'rename' }), 'perm-rename'),
      h('div', { class: 'row top' }, h('button', { class: 'btn', onclick: () => call('host', { action: 'mute-all' }).catch(() => {}) }, 'Mute everyone')));
  }

  // ---------- recording (local, host/co-host) ----------
  function startRecording() {
    const cv = document.createElement('canvas'); cv.width = 1280; cv.height = 720;
    const ctx = cv.getContext('2d');
    const ac = new AudioContext(); const dest = ac.createMediaStreamDestination();
    const added = new Set();
    const addAudio = (stream) => {
      if (added.has(stream.id) || !stream.getAudioTracks().length) return;
      added.add(stream.id);
      try { ac.createMediaStreamSource(new MediaStream(stream.getAudioTracks())).connect(dest); } catch { /* ignore */ }
    };
    if (S.local) addAudio(S.local);
    for (const m of S.streams.values()) for (const s of m.values()) addAudio(s);
    const draw = () => {
      ctx.fillStyle = '#0f1419'; ctx.fillRect(0, 0, 1280, 720);
      const vids = [...els.stage.querySelectorAll('.tile')].filter((t) => !t.classList.contains('nocam')).map((t) => t.querySelector('video')).filter((v) => v.readyState >= 2);
      const main = els.stage.querySelector('.tile.main:not(.nocam) video');
      const list = main ? [main] : vids;
      const n = list.length || 1, cols = Math.ceil(Math.sqrt(n)), rows = Math.ceil(n / cols);
      const w = 1280 / cols, hh = 720 / rows;
      list.forEach((v, i) => {
        if (!v.videoWidth) return;
        const sc = Math.min(w / v.videoWidth, hh / v.videoHeight), dw = v.videoWidth * sc, dh = v.videoHeight * sc;
        ctx.drawImage(v, (i % cols) * w + (w - dw) / 2, Math.floor(i / cols) * hh + (hh - dh) / 2, dw, dh);
      });
    };
    const timer = setInterval(draw, 66);
    const out = new MediaStream([...cv.captureStream(15).getVideoTracks(), ...dest.stream.getAudioTracks()]);
    const mime = ['video/webm;codecs=vp8,opus', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
    const mr = new MediaRecorder(out, mime ? { mimeType: mime } : undefined);
    const chunks = [];
    mr.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    mr.onstop = () => {
      clearInterval(timer); ac.close().catch(() => {});
      const url = URL.createObjectURL(new Blob(chunks, { type: 'video/webm' }));
      const a = h('a', { href: url, download: `${meeting.id}-recording.webm` });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      toast('Recording saved to your downloads.');
    };
    mr.start(1000);
    S.rec = { mr, addAudio };
  }
  async function toggleRecord() {
    if (S.rec) { S.rec.mr.stop(); S.rec = null; await call('record', { on: false }).catch(() => {}); }
    else {
      if (!confirm('Start recording? Everyone in the meeting will be notified. The file is saved on your device.')) return;
      startRecording(); await call('record', { on: true }).catch(() => {});
    }
    renderControls();
  }

  // ---------- events ----------
  const es = new EventSource(`/api/events?peer=${session.peer}&token=${session.token}`);
  const on = (name, fn) => es.addEventListener(name, (e) => fn(JSON.parse(e.data)));
  let sawRole = S.me.role;

  async function applyRoleChange() {
    const was = sawRole !== 'attendee', now = S.me.role !== 'attendee';
    sawRole = S.me.role;
    if (now && !was) {
      S.local = await getMedia({}); mesh.setLocal(S.local);
      S.me.cam = !!S.local && S.local.getVideoTracks().length > 0; S.me.mic = !!S.local && S.local.getAudioTracks().length > 0;
      call('state', { cam: S.me.cam, mic: S.me.mic }).catch(() => {});
      toast('You can now speak. You were promoted to panelist.');
    } else if (!now && was) {
      if (S.local) S.local.getTracks().forEach((t) => t.stop());
      S.local = null; mesh.setLocal(null);
      if (S.screen) stopShare();
      toast('You were moved to attendees.');
    }
    renderControls();
  }
  async function afterRoster() {
    const me = byId(S.me.id);
    if (me) { const wasStatus = S.me.status; S.me = { ...S.me, ...me, cam: S.me.cam, mic: S.me.mic }; if (wasStatus !== S.me.status && S.me.status === 'in') toast('You are in.'); }
    if (S.me.role !== sawRole) await applyRoleChange();
    els.waiting.hidden = S.me.status !== 'waiting';
    syncMesh(); renderStage(); renderControls();
    if (S.panel === 'people' || S.panel === 'breakouts') renderPanel();
  }

  on('hello', async (d) => {
    mesh.ice = d.ice; S.emojis = null;
    S.room = d.room; S.roster = d.roster; S.chat = d.chat; S.polls = d.polls; S.questions = d.questions;
    const me = d.roster.find((p) => p.id === S.me.id) || d.you;
    S.me = { ...S.me, ...me, cam: S.me.cam, mic: S.me.mic };
    if (canSpeak()) call('state', { cam: S.me.cam, mic: S.me.mic, name: undefined }).catch(() => {});
    els.title.textContent = S.room.title; els.rec.hidden = !S.room.recording;
    await afterRoster(); renderPanel();
  });
  on('roster', async (list) => { S.roster = list; await afterRoster(); });
  on('room', (r) => {
    const was = S.room.recording;
    S.room = r; els.title.textContent = r.title;
    els.rec.hidden = !r.recording; els.rec.textContent = r.recording ? `● Recording by ${r.recording.name}` : '';
    if (r.recording && !was && r.recording.by !== S.me.id) toast(`${r.recording.name} started recording this meeting.`, 'warn');
    if (!r.recording && was && S.rec == null) toast('Recording stopped.');
    renderStage(); renderControls(); if (S.panel) renderPanel();
  });
  on('signal', ({ from, data }) => mesh.onSignal(from, data));
  on('chat', (m) => { S.chat.push(m); if (S.chat.length > 500) S.chat.shift(); if (m.from !== S.me.id) refresh('chat'); else if (S.panel === 'chat') renderPanel(); });
  on('chathist', (list) => { S.chat = list; if (S.panel === 'chat') renderPanel(); });
  on('polls', (l) => { S.polls = l; if (S.panel === 'polls') renderPanel(); else { S.unread.polls = (S.unread.polls || 0) + 1; if (S.panel) renderPanel(); } });
  on('questions', (l) => { S.questions = l; refresh('qa'); });
  on('mute', ({ by }) => { if (S.local) { S.local.getAudioTracks().forEach((t) => { t.enabled = false; }); S.me.mic = false; call('state', { mic: false }).catch(() => {}); renderControls(); renderStage(); } toast(`${by} muted you.`, 'warn'); });
  on('stopshare', ({ by }) => { stopShare(); toast('Your screen share was stopped by a host.', 'warn'); });
  on('admitted', () => { S.me.status = 'in'; els.waiting.hidden = true; });
  on('moved', ({ channel }) => { S.me.channel = channel; S.pinned = null; toast(channel === 'main' ? 'You are back in the main meeting.' : 'You were moved to a breakout room.'); afterRoster(); });
  on('help', ({ name }) => toast(`${name} asks for help in a breakout room.`, 'warn'));
  on('broadcast', ({ from, text }) => { els.banner.hidden = false; els.banner.textContent = `${from}: ${text}`; clearTimeout(S.bt); S.bt = setTimeout(() => { els.banner.hidden = true; }, 15000); });
  on('reaction', ({ from, emoji }) => {
    const p = byId(from); const x = h('div', { class: 'float' }, emoji, h('small', {}, p ? p.name : ''));
    x.style.left = `${10 + Math.random() * 70}%`; els.reactions.append(x); setTimeout(() => x.remove(), 2600);
  });
  on('removed', ({ reason }) => finish(reason === 'denied' ? 'The host did not let you in.' : 'You were removed from the meeting.'));
  on('ended', () => finish('The host ended the meeting.'));
  es.onerror = () => { if (!S.ended && es.readyState === EventSource.CLOSED) finish('Connection lost.'); };

  function finish(message) {
    if (S.ended) return;
    S.ended = true; clearInterval(speakTimer);
    if (S.rec) { S.rec.mr.stop(); S.rec = null; }
    es.close(); mesh.closeAll();
    for (const s of [S.local, S.screen]) if (s) s.getTracks().forEach((t) => t.stop());
    clear(els.ended); els.ended.hidden = false;
    els.ended.append(h('div', { class: 'card center' }, h('h2', {}, message), h('p', { class: 'muted' }, 'You can rejoin with the same link if it is still open.'),
      h('div', { class: 'row center' }, h('a', { class: 'btn primary', href: `/m/${meeting.id}` }, 'Rejoin'), h('a', { class: 'btn', href: '/' }, 'Home'))));
  }
  function leave() {
    call('leave').catch(() => {});
    finish('You left the meeting.');
  }
  window.addEventListener('pagehide', () => { if (!S.ended) navigator.sendBeacon('/api/leave', JSON.stringify(auth())); });

  // initial paint (before the first server event)
  api('config').then((c) => { S.emojis = c.reactions; renderControls(); }).catch(() => {});
  renderControls();
  S.mesh = mesh;
  window.__km = S; // handy for tests and debugging
}
