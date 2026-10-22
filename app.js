// GOAT Meet — serverless P2P meetings (Trystero / WebRTC), build v1.2
// Media flows directly browser-to-browser (DTLS-SRTP encrypted).
// TWO independent discovery networks run in parallel (Nostr relays +
// WebTorrent trackers); whichever connects first wins, duplicates are merged
// by a per-tab identity so nobody appears twice.
const BUILD = 'v1.2'
const ENGINE_URL = './trystero.bundle.mjs?v=12'
const APP_ID = 'goat-meet-yeamin-v1'
const RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
  'wss://relay.primal.net',
  'wss://nostr.mom',
  'wss://relay.snort.social',
  'wss://offchain.pub',
  'wss://relay.nostr.bg'
]
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

let myName = '', roomName = ''
let myId = ''
try {
  myId = sessionStorage.getItem('gm-id') || ''
  if (!myId) { myId = Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4); sessionStorage.setItem('gm-id', myId) }
} catch (_) { myId = 'x' + Math.random().toString(36).slice(2, 10) }

const transports = []               // {label, room, chat, react, state}
const idents = new Map()            // identity -> peer record
const tpeerIdent = new Map()        // "label:peerId" -> identity
const seen = new Set()              // chat/reaction dedupe ids
let localStream = null, screenStream = null, screenOwnerId = null
let micOn = true, camOn = true, unread = 0, relayOpen = 0, msgSeq = 0
let audioCtx = null

/* ---------------- helpers ---------------- */
function toast(msg, ms = 2600) {
  els.toast.textContent = msg
  els.toast.classList.remove('hidden')
  clearTimeout(toast._t)
  toast._t = setTimeout(() => els.toast.classList.add('hidden'), ms)
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

/* ---------------- peer records / tiles ---------------- */
function makeTile(label) {
  const tile = document.createElement('div')
  tile.className = 'tile'
  const avatar = document.createElement('div'); avatar.className = 'avatar'; avatar.textContent = initials(label)
  const video = document.createElement('video'); video.autoplay = true; video.playsInline = true
  const lab = document.createElement('div'); lab.className = 'tile-label'; lab.textContent = label
  const mic = document.createElement('div'); mic.className = 'tile-mic hidden'; mic.textContent = '🔇'
  tile.append(avatar, video, lab, mic)
  els.grid.appendChild(tile)
  return {tile, video, avatar, lab, mic}
}
function identFor(id, nameHint) {
  let rec = idents.get(id)
  if (!rec) {
    const ui = makeTile(nameHint || 'Guest')
    rec = {id, name: nameHint || 'Guest', mic: true, cam: true, sources: new Map(), camKey: null, screenKey: null, ...ui}
    idents.set(id, rec)
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
function showScreen(rec, stream) {
  screenOwnerId = rec.id
  els.spotlightVideo.srcObject = stream
  els.spotlightLabel.textContent = `🖥️ ${rec.name} is sharing`
  els.spotlight.classList.remove('hidden')
}
function hideSpotlight() {
  screenOwnerId = null
  els.spotlightVideo.srcObject = null
  els.spotlight.classList.add('hidden')
}
function removeSource(rec, key) {
  const src = rec.sources.get(key)
  rec.sources.delete(key)
  if (!src) return
  if (rec.camKey === key) {
    rec.camKey = null
    const next = [...rec.sources.entries()].find(([, s]) => s.cam)
    if (next) { rec.camKey = next[0]; rec.video.srcObject = next[1].cam; watchSpeaking(next[1].cam, rec.tile) }
    else rec.video.srcObject = null
  }
  if (rec.screenKey === key) {
    rec.screenKey = null
    if (screenOwnerId === rec.id) {
      const next = [...rec.sources.entries()].find(([, s]) => s.screen)
      if (next) { rec.screenKey = next[0]; showScreen(rec, next[1].screen) } else hideSpotlight()
    }
  }
}

/* ---------------- transport wiring ---------------- */
function meta(kind) { return {kind, id: myId, name: myName} }
function sendAll(action, payload) { transports.forEach(t => { try { t[action]?.send(payload) } catch (_) {} }) }
function tuneSenders(t, peerId) {
  setTimeout(() => {
    try {
      const pc = t.room.getPeers?.()[peerId]; if (!pc) return
      pc.getSenders().forEach(s => {
        if (s.track?.kind !== 'video' || !s.getParameters) return
        const p = s.getParameters()
        p.encodings = [{maxBitrate: 900_000, maxFramerate: 24}]
        s.setParameters(p).catch(() => {})
      })
    } catch (_) {}
  }, 2500)
}
function wireTransport(t) {
  const key = pid => `${t.label}:${pid}`

  t.chat.onMessage = (data) => { if (!dedupe(data.mid)) addChat(data.name || 'Guest', data.text) }
  t.react.onMessage = (data) => {
    if (dedupe(data.rid)) return
    floater(data.emoji)
    toast(`${data.name || 'Someone'} reacted ${data.emoji}`, 1600)
  }
  t.state.onMessage = (data, {peerId}) => {
    if (!data.id || data.id === myId) return
    tpeerIdent.set(key(peerId), data.id)
    const rec = identFor(data.id, data.name)
    applyState(rec, data)
  }

  t.room.onPeerJoin = peerId => {
    try { t.state?.send({id: myId, name: myName, mic: micOn, cam: camOn}, {target: peerId}) } catch (_) {}
    if (localStream) t.room.addStream(localStream, {target: peerId, metadata: meta('cam')})
    if (screenStream) t.room.addStream(screenStream, {target: peerId, metadata: meta('screen')})
    tuneSenders(t, peerId)
  }

  t.room.onPeerStream = (stream, peerId, metadata) => {
    const id = metadata?.id
    if (!id || id === myId) return
    tpeerIdent.set(key(peerId), id)
    const rec = identFor(id, metadata.name)
    let src = rec.sources.get(key(peerId))
    if (!src) { src = {}; rec.sources.set(key(peerId), src) }
    if ((metadata.kind || 'cam') === 'screen') {
      src.screen = stream
      if (!rec.screenKey || screenOwnerId === id) { rec.screenKey = key(peerId); showScreen(rec, stream) }
      stream.getVideoTracks()[0]?.addEventListener('ended', () => removeSource(rec, key(peerId)))
    } else {
      src.cam = stream
      if (!rec.camKey) { rec.camKey = key(peerId); rec.video.srcObject = stream; watchSpeaking(stream, rec.tile) }
    }
  }

  t.room.onPeerLeave = peerId => {
    const id = tpeerIdent.get(key(peerId))
    tpeerIdent.delete(key(peerId))
    if (!id) return
    const rec = idents.get(id); if (!rec) return
    removeSource(rec, key(peerId))
    const stillConnected = [...tpeerIdent.values()].includes(id)
    if (!stillConnected && rec.sources.size === 0) {
      sysChat(`${rec.name} left`)
      rec.tile.remove()
      if (screenOwnerId === id) hideSpotlight()
      idents.delete(id)
      updateCount()
    }
  }
}

/* ---------------- join ---------------- */
async function join() {
  myName = els.name.value.trim() || 'Guest'
  roomName = sanitizeRoom(els.room.value) || randomRoom()
  try { localStorage.setItem('goatmeet-name', myName) } catch (_) {}
  if (!localStream) await startPreview()

  els.lobby.classList.add('hidden')
  els.call.classList.remove('hidden')
  els.roomLabel.textContent = 'Room: ' + roomName
  els.conn.textContent = 'connecting…'
  history.replaceState(null, '', '?room=' + encodeURIComponent(roomName))

  // my own tile
  const mine = makeTile(myName + ' (you)')
  mine.tile.classList.add('self')
  if (localStream) { mine.video.srcObject = localStream; watchSpeaking(localStream, mine.tile) }
  mine.mic.classList.toggle('hidden', micOn)
  syncCallButtons()

  let engine
  try {
    engine = await import(/* @vite-ignore */ENGINE_URL)
  } catch (e) {
    els.conn.textContent = 'could not load the meeting engine — refresh and try again'
    return
  }

  const cfgs = [
    ['nostr', () => engine.joinRoomNostr({appId: APP_ID, rtcConfig: ICE, relayConfig: {urls: RELAYS}}, roomName)],
    ['torrent', () => engine.joinRoomTorrent({appId: APP_ID, rtcConfig: ICE}, roomName)]
  ]
  for (const [label, make] of cfgs) {
    try {
      const roomT = make()
      const t = {label, room: roomT, chat: roomT.makeAction('chat'), react: roomT.makeAction('react'), state: roomT.makeAction('state')}
      transports.push(t)
      wireTransport(t)
      if (localStream) roomT.addStream(localStream, {metadata: meta('cam')})
    } catch (e) { console.warn(label, 'transport failed', e) }
  }
  if (!transports.length) { els.conn.textContent = 'no discovery network could start — refresh'; return }

  setInterval(() => {
    try {
      const socks = engine.getRelaySockets ? Object.values(engine.getRelaySockets()) : []
      relayOpen = socks.filter(s => s.readyState === 1).length
    } catch (_) {}
    if (idents.size === 0) {
      els.conn.textContent = `waiting for others · relays ${relayOpen}/${RELAYS.length} + torrent · share the link`
    }
  }, 3000)
  setTimeout(() => { if (relayOpen === 0 && idents.size === 0) toast('Still no relays after 25s — this network may block them. Try another network if nobody can join.', 7000) }, 25000)
  updateCount()
  sysChat('You joined room "' + roomName + '"')
}

/* ---------------- controls ---------------- */
function syncCallButtons() {
  els.btnMic.classList.toggle('off', !micOn)
  els.btnMic.innerHTML = (micOn ? '🎙️' : '🔇') + '<span>Mic</span>'
  els.btnCam.classList.toggle('off', !camOn)
  els.btnCam.innerHTML = (camOn ? '📷' : '🚫') + '<span>Camera</span>'
}
function broadcastState() { sendAll('state', {id: myId, name: myName, mic: micOn, cam: camOn}) }
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
  transports.forEach(t => t.room.addStream(screenStream, {metadata: meta('screen')}))
  screenStream.getVideoTracks()[0].addEventListener('ended', stopShare)
  toast('Sharing screen' + (screenStream.getAudioTracks().length ? ' with audio' : ''))
})
function stopShare() {
  if (!screenStream) return
  transports.forEach(t => { try { t.room.removeStream(screenStream, {metadata: meta('screen')}) } catch (_) {} })
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
  sendAll('react', {rid: myId + '-' + (++msgSeq) + '-' + Date.now(), emoji, name: myName})
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
  const payload = {mid: myId + '-' + (++msgSeq) + '-' + Date.now(), name: myName, text}
  dedupe(payload.mid)
  sendAll('chat', payload)
  addChat(myName, text, true)
})

$('#btn-leave').addEventListener('click', () => {
  transports.forEach(t => { try { t.room.leave() } catch (_) {} })
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
