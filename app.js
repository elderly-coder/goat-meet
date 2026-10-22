// GOAT Meet — serverless P2P meetings (Trystero / WebRTC)
// Media flows directly browser-to-browser (DTLS-SRTP encrypted).
// Public Nostr relays are used only to introduce peers to each other.
const TRYSTERO_CDN = './trystero.bundle.mjs' // vendored Trystero 0.26.0 — no CDN dependency
const APP_ID = 'goat-meet-yeamin-v1'
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

let myName = '', roomName = '', room = null
let actions = {}
let localStream = null, screenStream = null, screenOwner = null // peerId or 'self'
let micOn = true, camOn = true
let unread = 0
const peers = new Map() // peerId -> {name, mic, cam, tile, video, avatar, micIcon, analysers}
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
  const num = Math.floor(1000 + Math.random() * 9000)
  return `${pick(a)}-${pick(b)}-${num}`
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
function floater(emoji, xPct) {
  const s = document.createElement('span')
  s.className = 'floater'; s.textContent = emoji
  s.style.left = (xPct ?? 15 + Math.random() * 70) + '%'
  els.floaters.appendChild(s)
  setTimeout(() => s.remove(), 2700)
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
function makeTile(id, label, isSelf = false) {
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
function updateCount() {
  const n = peers.size + 1
  els.conn.textContent = `${n} in call · peer-to-peer · encrypted`
}

/* speaking indicator */
function watchSpeaking(stream, tileEl) {
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
      const avg = data.reduce((a, b) => a + b, 0) / data.length
      tileEl.classList.toggle('speaking', avg > 18)
    }, 220)
  } catch (_) { /* analyser optional */ }
}

/* tune outgoing video for mesh (5-person friendly bitrate) */
function tuneSenders(peerId) {
  setTimeout(() => {
    try {
      const pc = room?.getPeers?.()[peerId]; if (!pc) return
      pc.getSenders().forEach(s => {
        if (s.track?.kind !== 'video' || !s.getParameters) return
        const p = s.getParameters()
        p.encodings = [{maxBitrate: 900_000, maxFramerate: 24}]
        s.setParameters(p).catch(() => {})
      })
    } catch (_) {}
  }, 2500)
}

/* ---------------- state sync ---------------- */
function broadcastState(target) {
  actions.state?.send({name: myName, mic: micOn, cam: camOn}, target ? {target} : undefined)
}
function applyPeerState(id, st) {
  const p = peers.get(id); if (!p) return
  Object.assign(p, st)
  if (st.name) { p.lab.textContent = st.name; p.avatar.textContent = initials(st.name) }
  p.mic.classList.toggle('hidden', st.mic !== false)
  if (st.cam === false) { p.video.style.visibility = 'hidden' } else { p.video.style.visibility = '' }
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
  els.conn.textContent = 'connecting via relays…'
  history.replaceState(null, '', '?room=' + encodeURIComponent(roomName))

  // my own tile
  const mine = makeTile('self', myName + ' (you)', true)
  if (localStream) { mine.video.srcObject = localStream; watchSpeaking(localStream, mine.tile) }
  mine.mic.classList.toggle('hidden', micOn)
  syncCallButtons()

  let trystero
  try {
    trystero = await import(/* @vite-ignore */TRYSTERO_CDN)
  } catch (e) {
    els.conn.textContent = 'could not load the P2P engine — check your connection and refresh'
    toast('Failed to load meeting engine', 5000)
    return
  }

  room = trystero.joinRoom({appId: APP_ID, rtcConfig: ICE}, roomName)
  actions.chat = room.makeAction('chat')
  actions.react = room.makeAction('react')
  actions.state = room.makeAction('state')

  actions.chat.onMessage = (data, {peerId}) => addChat(data.name || peers.get(peerId)?.name || 'Guest', data.text)
  actions.react.onMessage = (data, {peerId}) => {
    floater(data.emoji)
    toast(`${data.name || peers.get(peerId)?.name || 'Someone'} reacted ${data.emoji}`, 1600)
  }
  actions.state.onMessage = (data, {peerId}) => applyPeerState(peerId, data)

  room.onPeerJoin = peerId => {
    const p = makeTile(peerId, 'Guest')
    peers.set(peerId, {name: 'Guest', mic: true, cam: true, ...p})
    sysChat('Someone joined')
    updateCount()
    broadcastState(peerId)
    if (localStream) room.addStream(localStream, {target: peerId, metadata: {kind: 'cam', name: myName}})
    if (screenStream) room.addStream(screenStream, {target: peerId, metadata: {kind: 'screen', name: myName}})
    tuneSenders(peerId)
  }

  room.onPeerLeave = peerId => {
    const p = peers.get(peerId)
    sysChat(`${p?.name || 'Someone'} left`)
    p?.tile.remove()
    if (screenOwner === peerId) hideSpotlight()
    peers.delete(peerId)
    updateCount()
  }

  room.onPeerStream = (stream, peerId, metadata) => {
    const p = peers.get(peerId); if (!p) return
    const kind = metadata?.kind || 'cam'
    if (metadata?.name) applyPeerState(peerId, {name: metadata.name})
    if (kind === 'screen') {
      screenOwner = peerId
      els.spotlightVideo.srcObject = stream
      els.spotlightLabel.textContent = `🖥️ ${metadata?.name || p.name} is sharing`
      els.spotlight.classList.remove('hidden')
      stream.getVideoTracks()[0]?.addEventListener('ended', () => { if (screenOwner === peerId) hideSpotlight() })
      stream.addEventListener('removetrack', () => { if (screenOwner === peerId) hideSpotlight() })
    } else {
      p.video.srcObject = stream
      watchSpeaking(stream, p.tile)
    }
  }

  if (localStream) room.addStream(localStream, {metadata: {kind: 'cam', name: myName}})
  setTimeout(() => { if (peers.size === 0) els.conn.textContent = 'just you here — share the link to invite your team' }, 4000)
  updateCount()
  sysChat('You joined room "' + roomName + '"')
}

function hideSpotlight() {
  screenOwner = null
  els.spotlightVideo.srcObject = null
  els.spotlight.classList.add('hidden')
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
  } catch (_) { return } // user cancelled picker
  screenOwner = 'self'
  els.spotlightVideo.srcObject = screenStream
  els.spotlightLabel.textContent = '🖥️ You are sharing your screen'
  els.spotlight.classList.remove('hidden')
  els.btnShare.classList.add('active')
  room?.addStream(screenStream, {metadata: {kind: 'screen', name: myName}})
  screenStream.getVideoTracks()[0].addEventListener('ended', stopShare)
  toast('Sharing screen' + (screenStream.getAudioTracks().length ? ' with audio' : '') )
})
function stopShare() {
  if (!screenStream) return
  room?.removeStream(screenStream, {metadata: {kind: 'screen', name: myName}})
  screenStream.getTracks().forEach(t => t.stop())
  screenStream = null
  els.btnShare.classList.remove('active')
  if (screenOwner === 'self') hideSpotlight()
}

$('#copy-btn').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(callUrl()); toast('Meeting link copied — send it to your team') }
  catch (_) { toast(callUrl(), 6000) }
})

$('#btn-react').addEventListener('click', () => $('#react-menu').classList.toggle('hidden'))
document.querySelectorAll('#react-menu button').forEach(b => b.addEventListener('click', () => {
  const emoji = b.dataset.emoji
  actions.react?.send({emoji, name: myName})
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
  actions.chat?.send({name: myName, text})
  addChat(myName, text, true)
})

$('#btn-leave').addEventListener('click', () => {
  try { room?.leave() } catch (_) {}
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
  const q = new URLSearchParams(location.search)
  const roomParam = q.get('room') || (location.hash || '').replace('#', '')
  if (roomParam) els.room.value = sanitizeRoom(roomParam)
  try { els.name.value = localStorage.getItem('goatmeet-name') || '' } catch (_) {}
  startPreview()
}
