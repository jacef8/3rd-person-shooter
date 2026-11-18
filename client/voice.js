// Voice chat: your crew (push to talk, on from the start) and, if you turn it on, anyone nearby who
// has it on too (heard from where they stand, fading with distance). Straight between players
// (WebRTC); the server only passes the introductions along and says who may talk to whom
// (server: 'voice', 'rtc', 'voicePeers').
//
// The microphone is only asked for the first time you talk. Every voice can be muted.
import { mixer } from '/sound.js';

const ICE = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];
const NEAR_FULL = 6, NEAR_GONE = 90;   // nearby voices: full volume within 6 m, gone by 90 m

export function createVoice({ send, myId, posOf, onTalking }) {
  const peers = new Map();   // id -> { pc, crew, offerer, tr, src, gain, panner, analyser, level, loudAt, el }
  let mic = null, micAsked = false, talking = false;
  const muted = new Set(JSON.parse(localStorage.getItem('dz_muted') || '[]'));

  async function getMic() {
    if (mic || micAsked) return mic;
    micAsked = true;
    try {
      mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      mic.getAudioTracks().forEach((t) => { t.enabled = talking; });
      for (const p of peers.values()) p.tr?.sender.replaceTrack(mic.getAudioTracks()[0]);
    } catch { micAsked = false; mic = null; onTalking?.(null, 'The microphone is blocked: allow it for this site in the browser to talk'); }
    return mic;
  }

  // One audio line each way per pair, opened by the player with the lower id (so the two never offer
  // at once); the microphone slots into it when it comes, with no new negotiation.
  function connect(id, crew) {
    const pc = new RTCPeerConnection({ iceServers: ICE });
    const offerer = myId() < id;
    const p = { pc, crew, offerer, level: 0, tr: null };
    peers.set(id, p);
    pc.onicecandidate = ({ candidate }) => { if (candidate) send({ t: 'rtc', to: id, data: { candidate } }); };
    if (offerer) {
      p.tr = pc.addTransceiver('audio', { direction: 'sendrecv' });
      if (mic) p.tr.sender.replaceTrack(mic.getAudioTracks()[0]);
      pc.onnegotiationneeded = async () => {
        try { await pc.setLocalDescription(); send({ t: 'rtc', to: id, data: { description: pc.localDescription } }); } catch { /* next change tries again */ }
      };
    }
    pc.ontrack = ({ streams, track }) => {
      const m = mixer();
      if (!m) return;
      const stream = streams[0] || new MediaStream([track]);
      // (Chrome only feeds a remote stream into Web Audio while an element is playing it, silently)
      p.el = new Audio(); p.el.srcObject = stream; p.el.muted = true; p.el.play().catch(() => {});
      p.src = m.ctx.createMediaStreamSource(stream);
      p.gain = m.ctx.createGain();
      p.analyser = m.ctx.createAnalyser(); p.analyser.fftSize = 256; p.buf = new Uint8Array(p.analyser.fftSize);
      p.panner = m.ctx.createStereoPanner ? m.ctx.createStereoPanner() : null;
      p.src.connect(p.analyser);
      p.src.connect(p.gain);
      if (p.panner) { p.gain.connect(p.panner); p.panner.connect(m.out); } else p.gain.connect(m.out);
    };
    pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') pc.restartIce?.(); };
    return p;
  }
  function drop(id) {
    const p = peers.get(id);
    if (!p) return;
    try { p.pc.close(); } catch { /* gone */ }
    try { p.src?.disconnect(); p.gain?.disconnect(); p.panner?.disconnect(); } catch { /* gone */ }
    if (p.el) p.el.srcObject = null;
    peers.delete(id);
  }

  return {
    /** Who you may hear now (from the server): [{ id, crew }]. */
    setPeers(list) {
      const want = new Map(list.map((q) => [q.id, q.crew]));
      for (const id of [...peers.keys()]) if (!want.has(id)) drop(id);
      for (const [id, crew] of want) { const p = peers.get(id); if (p) p.crew = crew; else connect(id, crew); }
    },
    /** A message from a peer, passed on by the server (perfect negotiation). */
    async signal(from, data) {
      const p = peers.get(from);
      if (!p) return;
      const pc = p.pc;
      try {
        if (data.description) {
          await pc.setRemoteDescription(data.description);
          if (data.description.type === 'offer') {
            p.tr = pc.getTransceivers()[0] || null;
            if (p.tr) { p.tr.direction = 'sendrecv'; if (mic) await p.tr.sender.replaceTrack(mic.getAudioTracks()[0]); }
            await pc.setLocalDescription();
            send({ t: 'rtc', to: from, data: { description: pc.localDescription } });
          }
        } else if (data.candidate) await pc.addIceCandidate(data.candidate);
      } catch { /* a bad message: the next one sorts it out */ }
    },
    /** Push to talk (or the open-mic toggle). */
    async talk(on) {
      talking = !!on;
      if (on && !mic) await getMic();
      mic?.getAudioTracks().forEach((t) => { t.enabled = talking; });
      onTalking?.(talking);
    },
    get talking() { return talking; },
    mute(id, on) { if (on) muted.add(id); else muted.delete(id); try { localStorage.setItem('dz_muted', JSON.stringify([...muted])); } catch { /* private */ } },
    isMuted: (id) => muted.has(id),
    /** Once a frame: nearby voices placed and faded by distance; who's speaking. Returns [{ id, crew, level }]. */
    update(me, yaw) {
      const out = [];
      for (const [id, p] of peers) {
        if (!p.gain) continue;
        let g = muted.has(id) ? 0 : 1, pan = 0;
        const q = posOf(id);
        if (!p.crew && q && me) {
          const d = Math.hypot(q.x - me.x, q.z - me.z);
          g *= d < NEAR_FULL ? 1 : Math.max(0, 1 - (d - NEAR_FULL) / (NEAR_GONE - NEAR_FULL)) ** 1.6;
          const ang = Math.atan2(q.x - me.x, q.z - me.z) - yaw;
          pan = -Math.sin(ang) * Math.min(1, d / 8) * 0.8;
        }
        p.gain.gain.value = g * 1.4;
        if (p.panner) p.panner.pan.value = pan;
        p.analyser.getByteTimeDomainData(p.buf);
        let peak = 0; for (const v of p.buf) peak = Math.max(peak, Math.abs(v - 128));
        p.level = Math.max(p.level * 0.85, peak / 128);
        if (p.level > 0.06 && g > 0.02) p.loudAt = performance.now();
        if (performance.now() - (p.loudAt || -1e9) < 700) out.push({ id, crew: p.crew, level: p.level });   // (held a moment between words)
      }
      return out;
    },
    /** (tests) where each connection stands */
    debug: () => [...peers].map(([id, p]) => ({ ctx: mixer()?.ctx.state, mic: !!mic, micOn: mic?.getAudioTracks()[0]?.enabled, sender: !!p.tr?.sender.track, id, crew: p.crew, offerer: p.offerer, state: p.pc.connectionState, sig: p.pc.signalingState, track: !!p.gain, level: +p.level.toFixed(3) })),
    close() { for (const id of [...peers.keys()]) drop(id); mic?.getTracks().forEach((t) => t.stop()); mic = null; micAsked = false; },
  };
}
