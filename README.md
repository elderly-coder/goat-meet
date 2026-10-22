# 🐐 GOAT Meet

Private peer-to-peer team meetings — no meeting server, no tracking, no AI listening, no time limits.

**Live:** open the GitHub Pages URL, type your name and a room, share the link. That's it.

## How it works

- The site itself is static files on GitHub Pages (this repo).
- Calls use **WebRTC** via [Trystero](https://github.com/dmotz/trystero): public Nostr relays only *introduce* peers to each other (signaling). After that, audio/video/chat travel **directly browser-to-browser**, encrypted with DTLS-SRTP. Nobody — not GitHub, not a relay — can see or record the call.
- Free public STUN/TURN relays (Google, Cloudflare, Metered OpenRelay) help connections cross home/mobile routers. They relay encrypted bytes they cannot decode.
- Designed for small teams (~2–6 people, mesh topology).

## Features

- Link join (`?room=your-room`) — no accounts, no install, works on mobile + desktop browsers
- Camera / mic with echo + noise cancellation, mute & camera-off (keys: `m` / `v`)
- Screen sharing with audio (Chrome/Edge: share a tab and tick "Share tab audio"; full-screen system audio works on Windows)
- In-meeting chat and emoji reactions — peer-to-peer, never stored anywhere
- Instant private room generator (unguessable room names)
- Speaking indicator, participant names, copy-link button

## Known limits

- Each participant uploads their video once per other participant, so very weak uplinks struggle with 5+ cameras on. Turn cameras off or let it settle — video is capped at ~0.9 Mbps to help.
- Mobile browsers can join/watch/share-camera but cannot *share their screen* (a mobile browser limitation everywhere, not just here).
- No recording or live captions — those need a server, which is exactly what this avoids.

## Run locally

```bash
python3 -m http.server 8080
# open http://localhost:8080
```

WebRTC requires HTTPS or localhost — GitHub Pages provides HTTPS.
