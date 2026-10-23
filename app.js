// GOAT Meet — serverless P2P meetings, build v1.3 (PeerJS mesh)
// Signaling: PeerJS Cloud introduces peers (host pattern). Media and data
// then flow directly browser-to-browser (DTLS-SRTP encrypted). No meeting
// server ever sees the call.
const BUILD = 'v1.4'
const ENGINE_URL = './peerjs.bundle.mjs?v=14'
const HOST_PREFIX = 'goatmeet-v3-'
const ICE = {
  iceServers: [
    {urls: 'stun:stun.l.google.com:19302'},
    {urls: 'stun:stun1.l.google.com:19302'},
    {urls: 'stun:stun.cloudflare.com:3478'},
    {urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject'},
    {urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject'},
    {urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject'}
  ]
}

const $ = s => document.querySelector(s)
const els = {
  lobby: $('#lobby'), call: $('#call'), preview: $('#preview'), previewOff: $('#preview-off'),
  mediaNote: $('#media-note'), name: $('#name-input'), room: $('#room-input'),
  grid: $('#grid'), spotlight: $('#spotlight'), spotlightVideo: $('#spotlight-video'),
  spotlightLabel: $('#spotlight-label'), roomLabel: $('#room-label'), conn: $('#conn-label'),
  chat: $('#chat'), chatLog: $('#chat-log'), chatBadge: $('#chat-badge'),
  toast: $('#toast'), floaters: $('#floaters'),
  btnMic: $('#btn-mic'), btnCam: $('#btn-cam'), btnShare: $('#btn-share')
}

let myName = '', roomName = '', hostId = ''
let myId = ''
try {
  myId = sessionStorage.getItem('gm-id') || ''
  if (!myId) { myId = Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4); sessionStorage.setItem('gm-id', myId) }
} catch (_) { myId = 'x' + Math.random().toString(36).slice(2, 10) }

let Peer = null, peer = null, amHost = false
const members = new Map()   // peerId -> {peerId, uid, name}  (everyone except me; host keeps the master list)
const conns = new Map()     // peerId -> DataConnection (open or opening)
const calls = new Map()     // peerId -> MediaConnection (camera calls)
const idents = new Map()    // uid -> tile record
const peerUid = new Map()   // peerId -> uid
const seen = new Set()
let localStream = null, screenStream = null, screenOwnerId = null, screenCalls = new Map()
let micOn = true, camOn = true, unread = 0, msgSeq = 0, joinedAt = Date.now()
let audioCtx = null

/* ---------------- helpers ---------------- */
function toast(msg, ms = 2600) {
  els.toast.textContent = msg
  els.toast.classList.remove('hidden')
  clearTimeout(toast._t)
  toast._t = setTimeout(() => els.toast.classList.add('hidden'), ms)
}
function dlog(msg) {
  const t = new Date().toTimeString().slice(0, 8)
  try {
    const box = document.querySelector('#diag-log')
    if (box) {
      const line = document.createElement('div')
      line.textContent = t + '  ' + msg
      box.appendChild(line)
      box.scrollTop = box.scrollHeight
      while (box.children.length > 60) box.firstChild.remove()
    }
  } catch (_) {}
  try { console.log('[gm]', msg) } catch (_) {}
}
function iceProbe() {
  // Self-test: what network paths can THIS device offer? Logged in the diag panel.
  try {
    const pc = new RTCPeerConnection(ICE)
    const tally = {host: 0, srflx: 0, relay: 0, other: 0}
    pc.onicecandidate = e => {
      if (!e.candidate) {
        dlog('network probe: candidates host=' + tally.host + ' srflx=' + tally.srflx + ' relay(TURN)=' + tally.relay + (tally.host + tally.srflx + tally.relay === 0 ? ' — NO usable network path from this device/browser' : ''))
        try { pc.close() } catch (_) {}
        return
      }
      const ty = e.candidate.type || 'other'
      if (ty in tally) tally[ty]++; else tally.other++
    }
    pc.createDataChannel('probe')
    pc.createOffer().then(o => pc.setLocalDescription(o)).catch(() => {})
    setTimeout(() => { try { pc.close() } catch (_) {} }, 8000)
  } catch (e) { dlog('network probe failed: ' + e.name) }
}
function sanitizeRoom(r) {
  return (r || '').toLowerCase().trim().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
}
function randomRoom() {
  const a = ['swift', 'quiet', 'amber', 'rapid', 'cosmic', 'velvet', 'golden', 'silent', 'brave', 'lunar']
  const b = ['falcon', 'river', 'summit', 'harbor', 'willow', 'cinder', 'meadow', 'orbit', 'cedar', 'comet']
  const pick = x => x[Math.floor(Math.random() * x.length)]
  return `${pick(a)}-${pick(b)}-${Math.floor(1000 + Math.random() * 9000)}`
}
function initials(name) { return (name || '?').trim().slice(0, 2).toUpperCase() }
function callUrl() { return `${location.origin}${location.pathname}?room=${encodeURIComponent(roomName)}` }
function sysChat(text) {
  const d = document.createElement('div')
  d.className = 'msg sys'; d.textContent = text
  els.chatLog.appendChild(d); els.chatLog.scrollTop = els.chatLog.scrollHeight
}
function addChat(name, text, mine = false) {
  const d = document.createElement('div')
  d.className = 'msg'
  const b = document.createElement('b'); b.textContent = mine ? `${name} (you)` : name
  d.appendChild(b); d.appendChild(document.createTextNode(text))
  els.chatLog.appendChild(d); els.chatLog.scrollTop = els.chatLog.scrollHeight
  if (!mine && els.chat.classList.contains('hidden')) {
    unread++; els.chatBadge.textContent = unread; els.chatBadge.classList.remove('hidden')
  }
}
function floater(emoji) {
  const s = document.createElement('span')
  s.className = 'floater'; s.textContent = emoji
  s.style.left = (15 + Math.random() * 70) + '%'
  els.floaters.appendChild(s)
  setTimeout(() => s.remove(), 2700)
}
function dedupe(id) {
  if (!id) return false
  if (seen.has(id)) return true
  seen.add(id)
  if (seen.size > 400) { const it = seen.values(); for (let i = 0; i < 100; i++) seen.delete(it.next().value) }
  return false
}

/* ---------------- lobby / preview ---------------- */
async function startPreview() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: {echoCancellation: true, noiseSuppression: true, autoGainControl: true},
      video: {width: {ideal: 1280}, height: {ideal: 720}, facingMode: 'user'}
    })
    els.preview.srcObject = localStream
    els.mediaNote.textContent = ''
    applyPreToggles()
  } catch (e) {
    els.mediaNote.textContent = 'Camera/mic not available yet (' + e.name + '). You can still join and watch/listen — allow access in the browser if asked.'
    localStream = null
  }
}
function applyPreToggles() {
  if (!localStream) return
  localStream.getAudioTracks().forEach(t => t.enabled = micOn)
  localStream.getVideoTracks().forEach(t => t.enabled = camOn)
  els.previewOff.classList.toggle('hidden', camOn)
  $('#pre-mic').classList.toggle('off', !micOn)
  $('#pre-cam').classList.toggle('off', !camOn)
  $('#pre-mic').textContent = micOn ? '🎙️' : '🔇'
  $('#pre-cam').textContent = camOn ? '📷' : '🚫'
}
$('#pre-mic').addEventListener('click', async () => { if (!localStream) await startPreview(); micOn = !micOn; applyPreToggles(); syncCallButtons() })
$('#pre-cam').addEventListener('click', async () => { if (!localStream) await startPreview(); camOn = !camOn; applyPreToggles(); syncCallButtons() })
$('#instant-btn').addEventListener('click', () => { els.room.value = randomRoom() })
$('#join-btn').addEventListener('click', join)
els.room.addEventListener('keydown', e => { if (e.key === 'Enter') join() })
els.name.addEventListener('keydown', e => { if (e.key === 'Enter') join() })

/* ---------------- tiles ---------------- */
function makeTile(label, isSelf = false) {
  const tile = document.createElement('div')
  tile.className = 'tile' + (isSelf ? ' self' : '')
  const avatar = document.createElement('div'); avatar.className = 'avatar'; avatar.textContent = initials(label)
  const video = document.createElement('video'); video.autoplay = true; video.playsInline = true; if (isSelf) video.muted = true
  const lab = document.createElement('div'); lab.className = 'tile-label'; lab.textContent = label
  const mic = document.createElement('div'); mic.className = 'tile-mic hidden'; mic.textContent = '🔇'
  tile.append(avatar, video, lab, mic)
  els.grid.appendChild(tile)
  return {tile, video, avatar, lab, mic}
}
function identFor(uid, nameHint) {
  let rec = idents.get(uid)
  if (!rec) {
    rec = {uid, name: nameHint || 'Guest', mic: true, cam: true, ...makeTile(nameHint || 'Guest')}
    idents.set(uid, rec)
    sysChat(`${rec.name} joined`)
    updateCount()
  }
  if (nameHint && rec.name === 'Guest') { rec.name = nameHint; rec.lab.textContent = nameHint; rec.avatar.textContent = initials(nameHint) }
  return rec
}
function applyState(rec, st) {
  if (st.name) { rec.name = st.name; rec.lab.textContent = st.name; rec.avatar.textContent = initials(st.name) }
  if (typeof st.mic === 'boolean') { rec.mic = st.mic; rec.mic.classList.toggle('hidden', st.mic) }
  if (typeof st.cam === 'boolean') { rec.cam = st.cam; rec.video.style.visibility = st.cam ? '' : 'hidden' }
}
function updateCount() {
  els.conn.textContent = `${idents.size + 1} in call · peer-to-peer · encrypted`
}
function watchSpeaking(stream, tileEl) {
  if (stream._watched) return
  stream._watched = true
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)()
    const track = stream.getAudioTracks()[0]; if (!track) return
    const src = audioCtx.createMediaStreamSource(new MediaStream([track]))
    const an = audioCtx.createAnalyser(); an.fftSize = 256
    src.connect(an)
    const data = new Uint8Array(an.frequencyBinCount)
    const iv = setInterval(() => {
      if (!tileEl.isConnected) { clearInterval(iv); return }
      an.getByteFrequencyData(data)
      const avg = data.reduce((x, y) => x + y, 0) / data.length
      tileEl.classList.toggle('speaking', avg > 18)
    }, 220)
  } catch (_) {}
}
function showScreen(uid, name, stream) {
  screenOwnerId = uid
  els.spotlightVideo.srcObject = stream
  els.spotlightLabel.textContent = `🖥️ ${name} is sharing`
  els.spotlight.classList.remove('hidden')
}
function hideSpotlight() {
  screenOwnerId = null
  els.spotlightVideo.srcObject = null
  els.spotlight.classList.add('hidden')
}
function removeIdent(uid, nameForMsg) {
  const rec = idents.get(uid); if (!rec) return
  sysChat(`${nameForMsg || rec.name} left`)
  rec.tile.remove()
  if (screenOwnerId === uid) hideSpotlight()
  idents.delete(uid)
  updateCount()
}

/* ---------------- data mesh ---------------- */
function sendTo(peerId, payload) {
  const c = conns.get(peerId)
  if (c?.open) { try { c.send(payload) } catch (_) {} }
}
function broadcast(payload, exceptPeerId) {
  conns.forEach((c, pid) => { if (pid !== exceptPeerId && c.open) { try { c.send(payload) } catch (_) {} } })
}
function broadcastState() { broadcast({t: 'state', uid: myId, name: myName, mic: micOn, cam: camOn}) }

function wireConn(conn) {
  const pid = conn.peer
  conns.set(pid, conn)
  conn.on('open', () => {
    conns.set(pid, conn)
    dlog('data link OPEN with ' + (pid === hostId ? 'the host' : pid))
    conn.send({t: 'hi', uid: myId, name: myName})
    conn.send({t: 'state', uid: myId, name: myName, mic: micOn, cam: camOn})
    if (amHost) {
      // I am host: a guest just connected to me directly.
      // (Their 'hello' arrives as data; handled below.)
    }
  })
  conn.on('data', data => onData(pid, data))
  conn.on('close', () => onPeerGone(pid))
  conn.on('error', () => {})
}
function connectToMember(m) {
  if (m.peerId === peer.id) return
  members.set(m.peerId, m)
  peerUid.set(m.peerId, m.uid)
  identFor(m.uid, m.name)
  if (!conns.has(m.peerId)) {
    const conn = peer.connect(m.peerId, {reliable: true})
    wireConn(conn)
  }
  callPeer(m.peerId)
}
function callPeer(pid) {
  if (!localStream || calls.has(pid)) return
  try {
    const call = peer.call(pid, localStream, {metadata: {kind: 'cam', uid: myId, name: myName}})
    wireCall(call)
  } catch (_) {}
}
function wireCall(call) {
  const pid = call.peer
  const kind = call.metadata?.kind || 'cam'
  if (kind === 'cam') calls.set(pid, call)
  call.on('stream', stream => {
    dlog('media received from ' + (call.metadata?.name || pid))
    const m = call.metadata || {}
    const uid = m.uid || peerUid.get(pid)
    if (!uid) return
    if (kind === 'screen') {
      showScreen(uid, m.name || members.get(pid)?.name || 'Guest', stream)
      stream.getVideoTracks()[0]?.addEventListener('ended', () => { if (screenOwnerId === uid) hideSpotlight() })
    } else {
      peerUid.set(pid, uid)
      const rec = identFor(uid, m.name)
      rec.video.srcObject = stream
      watchSpeaking(stream, rec.tile)
    }
  })
  call.on('close', () => {
    if (kind === 'cam') calls.delete(pid)
    if (kind === 'screen') {
      const uid = call.metadata?.uid || peerUid.get(pid)
      if (screenOwnerId === uid) hideSpotlight()
      screenCalls.delete(pid)
    }
  })
  call.on('error', () => {})
  watchIce(call, pid)
}
function watchIce(call, pid) {
  try {
    const pc = call.peerConnection; if (!pc) return
    const tally = {host: 0, srflx: 0, relay: 0}
    pc.onicecandidate = e => {
      if (e.candidate && e.candidate.type in tally) tally[e.candidate.type]++
      if (!e.candidate) dlog('call candidates (' + (members.get(pid)?.name || pid) + '): host=' + tally.host + ' srflx=' + tally.srflx + ' relay=' + tally.relay)
    }
    pc.oniceconnectionstatechange = () => {
      dlog('call link state (' + (members.get(pid)?.name || pid) + '): ' + pc.iceConnectionState)
      if (pc.iceConnectionState === 'failed') toast(`Connection to ${members.get(pid)?.name || 'a participant'} failed — their network may block peer-to-peer.`, 5000)
      if (pc.iceConnectionState === 'disconnected') setTimeout(() => { if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') onPeerGone(pid) }, 6000)
    }
  } catch (_) {}
}

function onData(fromPid, data) {
  if (!data || typeof data !== 'object') return
  switch (data.t) {
    case 'hi': {
      peerUid.set(fromPid, data.uid)
      if (!members.has(fromPid)) members.set(fromPid, {peerId: fromPid, uid: data.uid, name: data.name})
      identFor(data.uid, data.name)
      break
    }
    case 'hello': { // guest -> host only
      dlog('guest said hello: ' + (data.name || data.uid))
      if (!amHost) break
      const guest = {peerId: fromPid, uid: data.uid, name: data.name}
      const existing = [{peerId: peer.id, uid: myId, name: myName}, ...members.values()]
      members.set(fromPid, guest)
      peerUid.set(fromPid, data.uid)
      identFor(data.uid, data.name)
      sendTo(fromPid, {t: 'welcome', members: existing})
      broadcast({t: 'join', member: guest}, fromPid)
      break
    }
    case 'welcome': { // host -> guest: connect to everyone already here
      dlog('host welcomed us; ' + ((data.members || []).length) + ' participant(s) listed')
      ;(data.members || []).forEach(m => { if (m.peerId !== peer.id) connectToMember(m) })
      break
    }
    case 'join': { // someone new arrived (via host broadcast)
      if (data.member && data.member.peerId !== peer.id) {
        members.set(data.member.peerId, data.member)
        peerUid.set(data.member.peerId, data.member.uid)
        identFor(data.member.uid, data.member.name)
        // the newcomer initiates data+media to us; nothing to dial here
      }
      break
    }
    case 'leave': {
      const uid = data.uid || peerUid.get(data.peerId)
      members.delete(data.peerId)
      if (uid) removeIdent(uid, data.name)
      break
    }
    case 'chat': {
      if (dedupe(data.mid)) break
      addChat(data.name || 'Guest', data.text)
      break
    }
    case 'react': {
      if (dedupe(data.rid)) break
      floater(data.emoji)
      toast(`${data.name || 'Someone'} reacted ${data.emoji}`, 1600)
      break
    }
    case 'state': {
      if (!data.uid || data.uid === myId) break
      peerUid.set(fromPid, data.uid)
      applyState(identFor(data.uid, data.name), data)
      break
    }
  }
}

function onPeerGone(pid) {
  const uid = peerUid.get(pid)
  const wasMember = members.has(pid)
  conns.delete(pid); calls.delete(pid); screenCalls.delete(pid)
  peerUid.delete(pid); members.delete(pid)
  if (uid) {
    const stillThere = [...peerUid.values()].includes(uid)
    if (!stillThere) removeIdent(uid)
  }
  if (amHost && wasMember) broadcast({t: 'leave', peerId: pid, uid, name: undefined})
  if (pid === hostId && !amHost) tryClaimHost()
}

/* host election: if the host vanished, the earliest-joined remaining
   member tries to take over the host id so new joiners can still find us */
function tryClaimHost() {
  toast('Host left — re-forming the room…')
  let attempts = 0
  const claim = () => {
    attempts++
    const p = new Peer(hostId, {config: ICE})
    p.on('open', () => {
      // adopt as the join-host for NEW arrivals. The old peer object is
      // deliberately NOT destroyed — existing mesh connections live on it
      // and keep running; both peers stay wired.
      peer = p
      amHost = true
      wirePeerBasics()
      toast('You are the new room host')
    })
    p.on('error', e => {
      try { p.destroy() } catch (_) {}
      if (e.type === 'unavailable-id' && attempts < 6) setTimeout(claim, 2500)
    })
  }
  setTimeout(claim, 1500 + Math.random() * 1500)
}

/* ---------------- peer setup ---------------- */
function wirePeerBasics() {
  peer.on('connection', conn => {
    wireConn(conn)
    if (amHost) { /* hello handled in onData */ }
  })
  peer.on('call', call => {
    const kind = call.metadata?.kind || 'cam'
    if (call.metadata?.uid) peerUid.set(call.peer, call.metadata.uid)
    if (kind === 'screen') {
      call.answer() // receive-only for shares
      screenCalls.set(call.peer, call)
    } else {
      call.answer(localStream || undefined)
    }
    wireCall(call)
  })
  peer.on('disconnected', () => { try { peer.reconnect() } catch (_) {} })
  peer.on('error', e => {
    if (e.type === 'network' || e.type === 'server-error') toast('Signaling connection hiccup — retrying…', 3000)
  })
}

async function join() {
  myName = els.name.value.trim() || 'Guest'
  roomName = sanitizeRoom(els.room.value) || randomRoom()
  hostId = HOST_PREFIX + roomName
  try { localStorage.setItem('goatmeet-name', myName) } catch (_) {}
  if (!localStream) await startPreview()

  els.lobby.classList.add('hidden')
  els.call.classList.remove('hidden')
  els.roomLabel.textContent = 'Room: ' + roomName
  els.conn.textContent = 'connecting…'
  history.replaceState(null, '', '?room=' + encodeURIComponent(roomName))

  const mine = makeTile(myName + ' (you)', true)
  if (localStream) { mine.video.srcObject = localStream; watchSpeaking(localStream, mine.tile) }
  mine.mic.classList.toggle('hidden', micOn)
  syncCallButtons()
  joinedAt = Date.now()

  try {
    ;({Peer} = await import(/* @vite-ignore */ENGINE_URL))
  } catch (e) {
    els.conn.textContent = 'could not load the meeting engine — refresh and try again'
    return
  }

  // Try to be the host; if the id is taken, join as guest.
  dlog('joining room "' + roomName + '" as ' + myName)
  iceProbe()
  peer = new Peer(hostId, {config: ICE})
  peer.on('open', id => {
    amHost = true
    dlog('you are the HOST (first in room). Waiting for others to join this exact room name.')
    els.conn.textContent = 'just you here — share the link to invite your team'
    wirePeerBasics()
    sysChat('You created room "' + roomName + '"')
  })
  peer.on('error', e => {
    if (e.type !== 'unavailable-id') { toast('Connection error: ' + e.type, 4000); return }
    // guest path
    try { peer.destroy() } catch (_) {}
    peer = new Peer({config: ICE})
    peer.on('open', () => {
      amHost = false
      dlog('you joined as GUEST — a host already holds this room. Connecting to host…')
      wirePeerBasics()
      const conn = peer.connect(hostId, {reliable: true})
      wireConn(conn)
      const helloTimer = setInterval(() => {
        if (conn.open) { conn.send({t: 'hello', uid: myId, name: myName}); clearInterval(helloTimer) }
      }, 400)
      setTimeout(() => clearInterval(helloTimer), 15000)
      els.conn.textContent = 'joining room…'
      sysChat('You joined room "' + roomName + '"')
    })
    peer.on('error', e2 => { if (e2.type !== 'unavailable-id') toast('Connection error: ' + e2.type, 4000) })
  })
  updateCount()
}

/* ---------------- controls ---------------- */
function syncCallButtons() {
  els.btnMic.classList.toggle('off', !micOn)
  els.btnMic.innerHTML = (micOn ? '🎙️' : '🔇') + '<span>Mic</span>'
  els.btnCam.classList.toggle('off', !camOn)
  els.btnCam.innerHTML = (camOn ? '📷' : '🚫') + '<span>Camera</span>'
}
els.btnMic.addEventListener('click', toggleMic)
els.btnCam.addEventListener('click', toggleCam)
function toggleMic() {
  micOn = !micOn
  localStream?.getAudioTracks().forEach(t => t.enabled = micOn)
  syncCallButtons(); broadcastState()
}
function toggleCam() {
  camOn = !camOn
  localStream?.getVideoTracks().forEach(t => t.enabled = camOn)
  syncCallButtons(); broadcastState()
  const myVideo = els.grid.querySelector('.tile.self video')
  if (myVideo) myVideo.style.visibility = camOn ? '' : 'hidden'
}

els.btnShare.addEventListener('click', async () => {
  if (screenStream) { stopShare(); return }
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({video: true, audio: true})
  } catch (_) { return }
  screenOwnerId = myId
  els.spotlightVideo.srcObject = screenStream
  els.spotlightLabel.textContent = '🖥️ You are sharing your screen'
  els.spotlight.classList.remove('hidden')
  els.btnShare.classList.add('active')
  members.forEach((m, pid) => {
    try {
      const call = peer.call(pid, screenStream, {metadata: {kind: 'screen', uid: myId, name: myName}})
      screenCalls.set(pid, call)
      wireCall(call)
    } catch (_) {}
  })
  screenStream.getVideoTracks()[0].addEventListener('ended', stopShare)
  toast('Sharing screen' + (screenStream.getAudioTracks().length ? ' with audio' : ''))
})
function stopShare() {
  if (!screenStream) return
  screenCalls.forEach(c => { try { c.close() } catch (_) {} })
  screenCalls.clear()
  screenStream.getTracks().forEach(t => t.stop())
  screenStream = null
  els.btnShare.classList.remove('active')
  if (screenOwnerId === myId) hideSpotlight()
}

$('#copy-btn').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(callUrl()); toast('Meeting link copied — send it to your team') }
  catch (_) { toast(callUrl(), 6000) }
})

$('#btn-react').addEventListener('click', () => $('#react-menu').classList.toggle('hidden'))
document.querySelectorAll('#react-menu button').forEach(b => b.addEventListener('click', () => {
  const emoji = b.dataset.emoji
  const payload = {t: 'react', rid: myId + '-' + (++msgSeq) + '-' + Date.now(), emoji, name: myName}
  dedupe(payload.rid)
  broadcast(payload)
  floater(emoji)
  $('#react-menu').classList.add('hidden')
}))

$('#btn-chat').addEventListener('click', () => {
  els.chat.classList.toggle('hidden')
  if (!els.chat.classList.contains('hidden')) { unread = 0; els.chatBadge.classList.add('hidden'); $('#chat-input').focus() }
})
$('#chat-close').addEventListener('click', () => els.chat.classList.add('hidden'))
$('#chat-form').addEventListener('submit', e => {
  e.preventDefault()
  const text = $('#chat-input').value.trim(); if (!text) return
  $('#chat-input').value = ''
  const payload = {t: 'chat', mid: myId + '-' + (++msgSeq) + '-' + Date.now(), name: myName, text}
  dedupe(payload.mid)
  broadcast(payload)
  addChat(myName, text, true)
})

$('#btn-leave').addEventListener('click', () => {
  broadcast({t: 'leave', peerId: peer?.id, uid: myId, name: myName})
  try { peer?.destroy() } catch (_) {}
  localStream?.getTracks().forEach(t => t.stop())
  screenStream?.getTracks().forEach(t => t.stop())
  location.href = location.pathname + '?room=' + encodeURIComponent(roomName)
})

document.addEventListener('keydown', e => {
  if (els.call.classList.contains('hidden')) return
  if (/INPUT|TEXTAREA/.test(document.activeElement?.tagName || '')) return
  if (e.key === 'm') toggleMic()
  if (e.key === 'v') toggleCam()
})

/* ---------------- init ---------------- */
{
  const tag = $('#build-tag'); if (tag) tag.textContent = 'build ' + BUILD + ' · no servers · no tracking'
  const q = new URLSearchParams(location.search)
  const roomParam = q.get('room') || (location.hash || '').replace('#', '')
  if (roomParam) els.room.value = sanitizeRoom(roomParam)
  try { els.name.value = localStorage.getItem('goatmeet-name') || '' } catch (_) {}
  startPreview()
}
