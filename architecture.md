# Kestrel Meet architecture (two stacks, one protocol)

Shared product rules: roles host / cohost / participant (meetings) and host / cohost / panelist / attendee (webinars). The server, not the browser, decides who may mute, remove, lock, admit, share or speak.

## Stack A - zero-dependency Node + WebRTC (stack-a/)
- Server: one Node file using only built-ins (http, fs, crypto). Static files + JSON API + Server-Sent Events for realtime push. No npm.
- Media: browser WebRTC in a mesh (each browser connects to each other in its channel). Good for about 2-6 people. Webinar mode = panelists send, attendees receive only (attendees send nothing).
- Signaling: POST /api/signal relays offer/answer/ICE to one peer; SSE /api/events delivers them.
- Channels: "main" and "bN" breakout channels; media only connects inside a channel.
- State: in-memory rooms, scheduled meetings persisted to data/meetings.json.
- Recording: host browser mixes tiles onto a canvas + WebAudio mix, MediaRecorder, downloads .webm; server relays a recording notice to all.
- Limits (honest): STUN only (no TURN, so some strict networks fail), mesh cap, no accounts (host proves ownership with a host key kept in the browser).

## Stack B - Next.js + LiveKit (stack-b/)
- LiveKit (open-source SFU) carries media, so rooms scale far past a mesh.
- Next.js route handlers mint short-lived LiveKit access tokens with role-based grants (publish only for host/cohost/panelist, subscribe-only for attendees).
- Moderation through LiveKit's server API (mute, remove, update permissions).
- Meetings/scheduling in a small JSON store (swap for Postgres).
- Runs with docker-compose (LiveKit) + `npm run dev`. Written here but not executed here (npm registry unreachable in this workspace).

## Build order (thin slice first)
1. Rooms + signaling + 2-person video. 2. Controls, chat, roles. 3. Screen share, waiting room, lock. 4. Scheduling + .ics. 5. Recording, polls. 6. Breakouts. 7. Webinar mode + Q&A.
