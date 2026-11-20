// Voice chat: your crew (push to talk, on from the start) and, if you turn it on, anyone nearby who
// has it on too (heard from where they stand, fading with distance). Straight between players
// (WebRTC); the server only passes the introductions along and says who may talk to whom
// (server: 'voice', 'rtc', 'voicePeers').
//
// The relay: two players who can't reach each other directly (a phone on cellular data, a strict
// router) talk through the game server instead. If a direct line hasn't connected within RELAY_AFTER_MS,
// or fails, either side asks for the relay ('vrelay'); both switch. Speech then goes up the game's own
// connection as small binary frames (12 kHz, G.711 mu-law: about 12 KB/s while you talk, nothing
// while you don't) and the server passes them to whoever is relayed with you.
//
// The microphone is only asked for the first time you talk. Every voice can be muted.
import { mixer } from '/sound.js';

const ICE = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];
const NEAR_FULL = 6, NEAR_GONE = 90;   // nearby voices: full volume within 6 m, gone by 90 m
const RELAY_AFTER_MS = 7000;           // no direct line by then: through the server
const RELAY_RATE = 12000;              // relayed speech: samples a second
const AUDIO = 1;                       // binary frame type: [1, seq, ...mu-law]; from the server [1, seq, idLen, ...id, ...mu-law]

// G.711 mu-law: 16-bit speech in 8 bits a sample.
function muEncode(x) {
  let s = Math.max(-1, Math.min(1, x)) * 32635;
  const sign = s < 0 ? 0x80 : 0;
  if (sign) s = -s;
  s += 132;
  let exp = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exp > 0; mask >>= 1) exp--;
  return ~(sign | (exp << 4) | ((s >> (exp + 3)) & 0x0f)) & 0xff;
}
const MU_TABLE = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const u = ~i & 0xff, exp = (u >> 4) & 7, mant = u & 0x0f;
  const v = (((mant << 3) + 132) << exp) - 132;
  MU_TABLE[i] = (u & 0x80 ? -v : v) / 32768;
}

export function createVoice({ send, sendBin, myId, posOf, onTalking }) {
  const peers = new Map();   // id -> { pc, crew, offerer, tr, src, gain, panner, analyser, level, loudAt, el, relay, next }
  const relayAsked = new Set();   // peers the server has switched to the relay before we had them
  let mic = null, micAsked = false, talking = false;
  let cap = null;   // the relay's microphone tap: { src, proc, sink, pos, seq }
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
      if (!m || p.relay) return;
      const stream = streams[0] || new MediaStream([track]);
      // (Chrome only feeds a remote stream into Web Audio while an element is playing it, silently)
      p.el = new Audio(); p.el.srcObject = stream; p.el.muted = true; p.el.play().catch(() => {});
      p.src = m.ctx.createMediaStreamSource(stream);
      p.src.connect(output(p));
    };
    // No direct line in time, or it failed (cellular data, a strict router): ask for the relay.
    p.relayTimer = setTimeout(() => { if (peers.get(id) === p && !p.relay && pc.connectionState !== 'connected') askRelay(id); }, RELAY_AFTER_MS);
    pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed' && !p.relay) askRelay(id); };
    if (relayAsked.has(id)) useRelay(id);
    return p;
  }
  async function handle(p, from, data) {
    const pc = p.pc;
    if (peers.get(from) !== p || p.relay) return;   // dropped meanwhile, or talking through the server now
    try {
      if (data.description) {
        await pc.setRemoteDescription(data.description);
        for (const c of p.early || []) await pc.addIceCandidate(c).catch(() => {});
        p.early = null;
        if (data.description.type === 'offer') {
          p.tr = pc.getTransceivers()[0] || null;
          if (p.tr) { p.tr.direction = 'sendrecv'; if (mic) await p.tr.sender.replaceTrack(mic.getAudioTracks()[0]); }
          await pc.setLocalDescription();
          send({ t: 'rtc', to: from, data: { description: pc.localDescription } });
        }
      } else if (data.candidate) {
        if (!pc.remoteDescription) (p.early ||= []).push(data.candidate);   // before the offer/answer: keep it for then
        else await pc.addIceCandidate(data.candidate);
      }
    } catch { /* a bad message: the next one sorts it out */ }
  }
  /** Where a voice is played: its level meter, volume (distance, mute) and stereo place. */
  function output(p) {
    if (p.inp) return p.inp;
    const m = mixer();
    if (!m) return null;
    p.inp = m.ctx.createGain();
    p.gain = m.ctx.createGain();
    p.analyser = m.ctx.createAnalyser(); p.analyser.fftSize = 256; p.buf = new Uint8Array(p.analyser.fftSize);
    p.panner = m.ctx.createStereoPanner ? m.ctx.createStereoPanner() : null;
    p.inp.connect(p.analyser);
    p.inp.connect(p.gain);
    if (p.panner) { p.gain.connect(p.panner); p.panner.connect(m.out); } else p.gain.connect(m.out);
    return p.inp;
  }
  function askRelay(id) { send({ t: 'vrelay', id }); }
  /** The server switched this pair to the relay: close the direct line, take speech from the server. */
  function useRelay(id) {
    const p = peers.get(id);
    if (!p) { relayAsked.add(id); return; }
    relayAsked.delete(id);
    if (p.relay) return;
    p.relay = true;
    clearTimeout(p.relayTimer);
    try { p.pc.close(); } catch { /* gone */ }
    try { p.src?.disconnect(); } catch { /* gone */ }
    if (p.el) p.el.srcObject = null;
    p.src = null; p.el = null;
    capture();
  }
  /** While you talk and someone hears you through the relay: the microphone, cut into frames. */
  function capture() {
    const want = talking && mic && [...peers.values()].some((p) => p.relay);
    const m = mixer();
    if (!want || !m) { if (cap) { try { cap.src.disconnect(); cap.proc.disconnect(); cap.sink.disconnect(); } catch { /* gone */ } cap = null; } return; }
    if (cap) return;
    const src = m.ctx.createMediaStreamSource(mic);
    const proc = m.ctx.createScriptProcessor(2048, 1, 1);
    const sink = m.ctx.createGain(); sink.gain.value = 0;   // (a script processor only runs while it's connected to something)
    const step = m.ctx.sampleRate / RELAY_RATE;
    cap = { src, proc, sink, pos: 0, seq: 0 };
    proc.onaudioprocess = (e) => {
      if (!cap || cap.proc !== proc) return;
      const x = e.inputBuffer.getChannelData(0);
      // Down to 12 kHz, each output sample the average of the input it covers (a simple low-pass).
      const n = Math.floor((x.length - cap.pos) / step);
      if (n <= 0) { cap.pos -= x.length; return; }
      const out = new Uint8Array(2 + n);
      out[0] = AUDIO; out[1] = cap.seq = (cap.seq + 1) & 0xff;
      let peak = 0;
      for (let i = 0; i < n; i++) {
        const a = Math.floor(cap.pos + i * step), b = Math.max(a + 1, Math.floor(cap.pos + (i + 1) * step));
        let sum = 0; for (let k = a; k < b && k < x.length; k++) sum += x[k];
        const v = sum / (b - a);
        if (Math.abs(v) > peak) peak = Math.abs(v);
        out[2 + i] = muEncode(v);
      }
      cap.pos = cap.pos + n * step - x.length;
      if (peak > 0.004) sendBin?.(out.buffer);   // (silence isn't sent)
    };
    src.connect(proc); proc.connect(sink); sink.connect(m.ctx.destination);
  }
  /** Speech from the server for a relayed peer: decoded and queued just ahead of now (a little
   *  buffer against the network's unevenness; too far behind, it catches up). */
  function relayIn(data) {
    const u = new Uint8Array(data);
    if (u[0] !== AUDIO || u.length < 4) return;
    const idLen = u[2], id = String.fromCharCode(...u.subarray(3, 3 + idLen));
    const p = peers.get(id), m = mixer();
    if (!p || !p.relay || !m) return;
    const inp = output(p);
    const pcm = u.subarray(3 + idLen), n = pcm.length;
    if (!n || !inp) return;
    const buf = m.ctx.createBuffer(1, n, RELAY_RATE), ch = buf.getChannelData(0);
    for (let i = 0; i < n; i++) ch[i] = MU_TABLE[pcm[i]];
    const now = m.ctx.currentTime;
    if (!p.next || p.next < now + 0.02) p.next = now + 0.12;   // starting, or ran dry: build the buffer back up
    else if (p.next > now + 0.6) return;                     // far behind: drop this one and catch up
    const s = m.ctx.createBufferSource();
    s.buffer = buf; s.connect(inp); s.start(p.next);
    p.next += n / RELAY_RATE;
  }
  function drop(id) {
    const p = peers.get(id);
    if (!p) return;
    try { p.pc.close(); } catch { /* gone */ }
    clearTimeout(p.relayTimer);
    try { p.src?.disconnect(); p.inp?.disconnect(); p.gain?.disconnect(); p.panner?.disconnect(); } catch { /* gone */ }
    if (p.el) p.el.srcObject = null;
    peers.delete(id);
    if (p.relay) capture();
  }

  return {
    /** Who you may hear now (from the server): [{ id, crew }]. */
    setPeers(list) {
      const want = new Map(list.map((q) => [q.id, q.crew]));
      for (const id of [...peers.keys()]) if (!want.has(id)) drop(id);
      for (const [id, crew] of want) { const p = peers.get(id); if (p) p.crew = crew; else connect(id, crew); }
      for (const id of [...relayAsked]) if (!want.has(id)) relayAsked.delete(id);
    },
    /** A message from a peer, passed on by the server. Handled one at a time, in order: a network
     *  route (candidate) that arrives while the offer is still being taken in waits for it, instead
     *  of being thrown away (which left some pairs never hearing each other). */
    signal(from, data) {
      const p = peers.get(from);
      if (!p) return;
      p.queue = (p.queue || Promise.resolve()).then(() => handle(p, from, data));
      return p.queue;
    },
    /** Push to talk (or the open-mic toggle). */
    async talk(on) {
      talking = !!on;
      if (on && !mic) await getMic();
      mic?.getAudioTracks().forEach((t) => { t.enabled = talking; });
      capture();
      onTalking?.(talking);
    },
    /** The server switched a peer to the relay ('vrelay'). */
    useRelay,
    /** A binary frame from the server: relayed speech. */
    relayIn,
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
    debug: () => [...peers].map(([id, p]) => ({ relay: !!p.relay, cap: !!cap, ctx: mixer()?.ctx.state, mic: !!mic, micOn: mic?.getAudioTracks()[0]?.enabled, sender: !!p.tr?.sender.track, id, crew: p.crew, offerer: p.offerer, state: p.pc.connectionState, sig: p.pc.signalingState, track: !!p.gain, level: +p.level.toFixed(3) })),
    close() { for (const id of [...peers.keys()]) drop(id); talking = false; capture(); mic?.getTracks().forEach((t) => t.stop()); mic = null; micAsked = false; },
  };
}
