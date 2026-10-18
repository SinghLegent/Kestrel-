# Recon map: Zoom Meetings and Webinars (web)

Scope: the core meeting loop, scheduling and local recording, breakout rooms, and webinar mode.
For: the builder's own video-meeting product (rebranded, clean-room).
Method: public help pages, university IT guides, public pricing summaries. No decompilation, no private APIs, no logged-in scraping, no code or assets taken.

## Sources

| # | source | URL | notes |
| --- | --- | --- | --- |
| 1 | Host controls guide (SFU IT) | https://sfu.teamdynamix.com/TDClient/255/ITServices/KB/PrintArticle?ID=4080 | lock, waiting room, permissions, remove, mute, co-host, share limits, local recording, breakouts |
| 2 | Webinar guide (U-Michigan ITS) | https://documentation.its.umich.edu/zoom-webinars | roles, attendee limits, Q&A, polls, raise hand, registration, practice session, capacity |
| 3 | Additional features (Toronto Metropolitan Univ.) | https://www.torontomu.ca/content/ryerson/courses/toolbox/zoom/additional-features/ | polls, breakouts auto/manual, whiteboard, sharing defaults, co-host limits, cloud recording |
| 4 | Pricing summary (Pumble, updated 2026-03) | https://pumble.com/zoom-pricing | tiers: 100 participants and 40 minutes free, 300 on Business, webinars on Enterprise |

## Core loop

Start or join a link, see and hear everyone, share a screen, and let a host keep the room orderly.

## Screens

| ID | screen | how to reach | purpose | key components |
| --- | --- | --- | --- | --- |
| S01 | Home | / | start instant meeting, join by code, see upcoming | buttons, code input, list |
| S02 | Schedule | /schedule | title, time, duration, passcode, waiting room, webinar toggle | form |
| S03 | Pre-join | /m/:id | name, camera and mic preview, device pick | video preview, selects |
| S04 | Waiting | after pre-join when waiting room is on | wait for host to admit | spinner, message |
| S05 | Meeting | in room | video grid, controls bar, side panels | tiles, toolbar, chat, people, polls, Q&A |
| S06 | Breakout manager | host panel | create rooms, assign, open, broadcast, close | list, drag or select |
| S07 | Ended or removed | exit | reason and rejoin | message |

## Flows

```
F01 Start and share: S01 -> S03 -> S05 (copy link)      clicks: 3
F02 Join by code:    S01 -> S03 -> (S04) -> S05          clicks: 3
F03 Schedule:        S01 -> S02 -> invite link + .ics    clicks: 4
F04 Host moderates:  S05 -> security menu / people panel
F05 Breakouts:       S05 -> S06 -> participants move -> broadcast -> close all
F06 Webinar:         S02 (webinar on) -> host + panelists publish, attendees watch, Q&A
F07 Record:          S05 -> record (everyone notified) -> stop -> file download
```
edge: lock while someone is joining, host leaves, passcode wrong, camera denied, screen share while another is sharing.

## Components

Button, toggle, toolbar, video tile (name, muted badge, hand, speaking ring), side panel, chat bubble, poll card, toast, modal, select.

## Inferred data model

```
Meeting   id, title, mode (meeting|webinar), start_at, duration_min, passcode?, waiting_room, host_key
Peer      id, name, role (host|cohost|participant|panelist|attendee), muted_by_host, hand, channel, status (waiting|in)
Channel   main | breakout:<n>   (media only flows inside a channel)
Message   from, to (all|peer), text, ts
Poll      id, question, options[], votes{peer:option}, open
Question  id, from, text, answered_by?, answer?
```
confidence: medium (inferred from public behavior descriptions, not from internals).

## What cannot be cloned

Their global media network and data centres, phone and rooms hardware, marketplace partners, trademarks and branding, and AI features that depend on proprietary models.

## Size

M for core meetings on WebRTC mesh (about 2-6 people per room). L for 100+ participants, which needs a media server (SFU). Hardest parts: reliable signaling and reconnects, mixing audio for local recording, role enforcement on the server, webinar scale.
