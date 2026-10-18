# Kestrel Meet, Stack B (Next.js + LiveKit)

> **Status: written but NOT run.** The build environment could not reach the npm registry, so this
> stack has never been installed, built or tested. Stack A (`../stack-a`) is the tested one.
> Expect to fix small things (package versions, the LiveKit participant API shape) on first run.

Why this stack: Stack A is a peer-to-peer mesh, fine for about 2 to 6 cameras. LiveKit is an SFU
(one server relays media), so rooms of dozens work and webinar attendees are cheap.

## Run it
```bash
docker compose up -d          # LiveKit server on :7880 (dev keys in livekit.yaml)
cp .env.example .env.local
npm install
npm run dev                   # http://localhost:3000
```
Open two browser windows: start a meeting in one, paste the link in the other.

## What is here
- `app/api/join`: checks passcode, lock and waiting room, then mints a LiveKit token whose grants depend on the role
  (host/co-host: admin; participant/panelist: publish; webinar attendee: subscribe + data only).
- `app/api/host`: moderation through the LiveKit server API (mute, mute all, remove, end, lock, waiting room, co-host, panelist).
- `app/api/meetings`, `.../ics`: create and read meetings, calendar invite file.
- `app/m/[code]`: pre-join, waiting-room polling, `<VideoConference/>` and a basic host panel.

## Not done in Stack B (Stack A has them)
Polls, Q&A UI, breakout-room UI (the room-naming helper `roomName(code, "b1")` and per-channel tokens exist),
raise hand/reactions beyond LiveKit defaults, recording (use LiveKit Egress), host-key proof is a localStorage bearer secret.
