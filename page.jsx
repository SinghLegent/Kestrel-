'use client';
import { use, useEffect, useRef, useState } from 'react';
import { LiveKitRoom, VideoConference } from '@livekit/components-react';

const ERR = { 'no-meeting': 'That meeting does not exist.', passcode: 'The passcode is not right.', locked: 'The host has locked this meeting.' };

export default function MeetingPage({ params }) {
  const { code } = use(params);
  const [meeting, setMeeting] = useState(null);
  const [name, setName] = useState('');
  const [passcode, setPasscode] = useState('');
  const [err, setErr] = useState('');
  const [session, setSession] = useState(null); // { token, url, role, identity }
  const [waiting, setWaiting] = useState(false);
  const hostKey = useRef(null);
  const identity = useRef(null);

  useEffect(() => {
    hostKey.current = localStorage.getItem(`km.host.${code}`);
    setName(localStorage.getItem('km.name') || '');
    fetch(`/api/meetings/${code}`).then((r) => (r.ok ? r.json() : Promise.reject())).then(setMeeting).catch(() => setErr(ERR['no-meeting']));
  }, [code]);

  async function join() {
    if (!name.trim()) return setErr('Please enter your name.');
    localStorage.setItem('km.name', name.trim());
    setErr('');
    const res = await fetch('/api/join', { method: 'POST', body: JSON.stringify({ meeting: code, name, passcode, hostKey: hostKey.current, identity: identity.current }) });
    const d = await res.json();
    if (!res.ok) return setErr(ERR[d.error] || 'Something went wrong.');
    identity.current = d.identity;
    if (d.status === 'waiting') { setWaiting(true); setTimeout(join, 2500); return; } // poll until the host admits us
    setWaiting(false); setSession(d);
  }

  if (session) {
    return (
      <div className="room">
        <LiveKitRoom token={session.token} serverUrl={session.url} connect video={session.role !== 'attendee'} audio={session.role !== 'attendee'} onDisconnected={() => setSession(null)} data-lk-theme="default">
          <VideoConference />
        </LiveKitRoom>
        {(session.role === 'host' || session.role === 'cohost') && <HostPanel code={code} hostKey={hostKey.current} mode={meeting?.mode} />}
      </div>
    );
  }
  return (
    <main className="page">
      <div className="card">
        <h1>{meeting?.title || 'Meeting'}</h1>
        <p className="muted">{meeting ? `${meeting.mode === 'webinar' ? 'Webinar' : 'Meeting'} · ${code}` : ''}</p>
        {waiting ? <p role="status">Waiting for the host to let you in…</p> : (<>
          <div className="row"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" aria-label="Your name" /></div>
          {meeting?.needsPasscode && !hostKey.current && <div className="row" style={{ marginTop: '.6rem' }}><input value={passcode} onChange={(e) => setPasscode(e.target.value)} placeholder="Passcode" aria-label="Passcode" /></div>}
          <p className="error" role="alert">{err}</p>
          <button className="btn primary" onClick={join} disabled={!meeting}>{hostKey.current ? 'Start meeting' : 'Join now'}</button>
        </>)}
      </div>
    </main>
  );
}

function HostPanel({ code, hostKey, mode }) {
  const [waiting, setWaiting] = useState([]);
  const [locked, setLocked] = useState(false);
  const call = (action, extra = {}) => fetch('/api/host', { method: 'POST', body: JSON.stringify({ meeting: code, hostKey, action, ...extra }) });
  useEffect(() => {
    const t = setInterval(async () => {
      const r = await fetch(`/api/status?meeting=${code}&hostKey=${hostKey}`);
      if (r.ok) { const d = await r.json(); setWaiting(d.waiting); setLocked(d.locked); }
    }, 2000);
    return () => clearInterval(t);
  }, [code, hostKey]);
  return (
    <aside className="host-panel" aria-label="Host controls">
      <h3>Host controls</h3>
      <div className="row">
        <button className="btn" onClick={() => call('mute-all')}>Mute all</button>
        <button className="btn" onClick={() => call('lock', { on: !locked })}>{locked ? 'Unlock' : 'Lock'}</button>
        <button className="btn" onClick={() => call('waiting', { on: true })}>Waiting room on</button>
        <button className="btn" onClick={() => { if (confirm('End for everyone?')) call('end'); }}>End for all</button>
      </div>
      <h3>Waiting room ({waiting.length})</h3>
      {waiting.map((w) => (
        <div key={w.identity} className="row"><strong>{w.name}</strong>
          <button className="btn" onClick={() => call('admit', { target: w.identity })}>Admit</button>
          <button className="btn" onClick={() => call('deny', { target: w.identity })}>Deny</button></div>
      ))}
      {mode === 'webinar' && <p className="muted">Promote an attendee to panelist by identity via POST /api/host (action "panelist"). A picker UI is left for a later pass.</p>}
    </aside>
  );
}
