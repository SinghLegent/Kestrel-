// WebRTC mesh using the "perfect negotiation" pattern, so either side can add or
// remove tracks (screen share, role changes) at any time without offer collisions.
class Link {
  constructor(mesh, remoteId, kind, initiator) {
    this.mesh = mesh; this.remoteId = remoteId; this.kind = kind;
    this.polite = !initiator;
    this.makingOffer = false; this.ignoreOffer = false;
    this.screenSenders = [];
    const pc = this.pc = new RTCPeerConnection({ iceServers: mesh.ice });
    pc.onicecandidate = (e) => { if (e.candidate) mesh.signal(remoteId, { candidate: e.candidate }); };
    pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await pc.setLocalDescription();
        mesh.signal(remoteId, { description: pc.localDescription });
      } catch (e) { console.warn('negotiation', e); } finally { this.makingOffer = false; }
    };
    pc.ontrack = ({ track, streams }) => {
      const stream = streams[0] || new MediaStream([track]);
      mesh.onStream(remoteId, stream);
    };
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed') pc.restartIce();
    };
    if (initiator) this.addLocal(true);
  }

  addLocal(initial = false) {
    const { local, screen } = this.mesh;
    const have = new Set(this.pc.getSenders().map((s) => s.track).filter(Boolean));
    let added = 0;
    if (local) for (const t of local.getTracks()) if (!have.has(t)) { this.pc.addTrack(t, local); added++; }
    if (screen) for (const t of screen.getTracks()) if (!have.has(t)) { this.screenSenders.push(this.pc.addTrack(t, screen)); added++; }
    // Receive-only side (webinar attendee): ask to receive audio and video.
    if (initial && !local) {
      this.pc.addTransceiver('audio', { direction: 'recvonly' });
      this.pc.addTransceiver('video', { direction: 'recvonly' });
    }
    return added;
  }

  removeScreen() {
    for (const s of this.screenSenders) { try { this.pc.removeTrack(s); } catch { /* already gone */ } }
    this.screenSenders = [];
  }

  async handle({ description, candidate }) {
    const pc = this.pc;
    try {
      if (description) {
        const collision = description.type === 'offer' && (this.makingOffer || pc.signalingState !== 'stable');
        this.ignoreOffer = !this.polite && collision;
        if (this.ignoreOffer) return;
        await pc.setRemoteDescription(description);
        if (description.type === 'offer') {
          this.addLocal(false); // reuse the transceivers the offer created
          await pc.setLocalDescription();
          this.mesh.signal(this.remoteId, { description: pc.localDescription });
        }
      } else if (candidate) {
        try { await pc.addIceCandidate(candidate); } catch (e) { if (!this.ignoreOffer) throw e; }
      }
    } catch (e) { console.warn('signal', e); }
  }

  close() { try { this.pc.close(); } catch { /* ignore */ } }
}

export class Mesh {
  constructor({ meId, ice, signal, onStream, onGone }) {
    this.meId = meId; this.ice = ice; this.signal = signal;
    this.onStream = onStream; this.onGone = onGone;
    this.links = new Map(); this.local = null; this.screen = null;
    this.pending = new Map(); // signals that arrived before the roster introduced the peer
  }

  // targets: [{id, kind}] where kind encodes who sends media (changes force a rebuild)
  sync(targets) {
    const want = new Map(targets.map((t) => [t.id, t.kind]));
    for (const [id, link] of [...this.links]) {
      if (!want.has(id) || want.get(id) !== link.kind) { link.close(); this.links.delete(id); this.onGone(id); }
    }
    for (const [id, kind] of want) {
      if (!this.links.has(id) && this.meId < id) this.links.set(id, new Link(this, id, kind, true));
    }
    this._kinds = want;
    for (const id of want.keys()) {
      const q = this.pending.get(id);
      if (q) { this.pending.delete(id); for (const d of q) this.onSignal(id, d); }
    }
  }

  async onSignal(from, data) {
    let link = this.links.get(from);
    if (!link) {
      const kind = this._kinds && this._kinds.get(from);
      if (!kind) { // not a known target yet: hold briefly, drop if it never becomes one
        const q = this.pending.get(from) || [];
        if (q.length < 50) q.push(data);
        this.pending.set(from, q);
        setTimeout(() => this.pending.delete(from), 5000);
        return;
      }
      link = new Link(this, from, kind, false);
      this.links.set(from, link);
    }
    await link.handle(data);
  }

  setLocal(stream) { this.local = stream; for (const l of this.links.values()) l.addLocal(false); }

  setScreen(stream) {
    if (!stream) { for (const l of this.links.values()) l.removeScreen(); this.screen = null; return; }
    this.screen = stream;
    for (const l of this.links.values()) l.addLocal(false);
  }

  async replaceTrack(kind, track) {
    for (const l of this.links.values()) {
      const s = l.pc.getSenders().find((x) => x.track && x.track.kind === kind && !l.screenSenders.includes(x));
      if (s) await s.replaceTrack(track);
    }
  }

  closeAll() { for (const l of this.links.values()) l.close(); this.links.clear(); }
}
