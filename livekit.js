import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';

const url = process.env.LIVEKIT_URL || 'ws://localhost:7880';
const key = process.env.LIVEKIT_API_KEY;
const secret = process.env.LIVEKIT_API_SECRET;
export const roomService = () => new RoomServiceClient(url.replace(/^ws/, 'http'), key, secret);

// Role -> LiveKit grants. The server is the only place that decides who may publish.
export function grantsFor(role) {
  switch (role) {
    case 'host': case 'cohost': return { roomAdmin: true, canPublish: true, canPublishData: true, canSubscribe: true };
    case 'panelist': case 'participant': return { canPublish: true, canPublishData: true, canSubscribe: true };
    default: return { canPublish: false, canPublishData: true, canSubscribe: true }; // webinar attendee: watch, chat, Q&A
  }
}

export async function mintToken({ room, identity, name, role }) {
  const at = new AccessToken(key, secret, { identity, name, ttl: '4h', metadata: JSON.stringify({ role }) });
  at.addGrant({ room, roomJoin: true, ...grantsFor(role) });
  return at.toJwt();
}

// Breakout rooms are separate LiveKit rooms named "<code>__b<n>"; media never crosses between them.
export const roomName = (code, channel = 'main') => (channel === 'main' ? code : `${code}__${channel}`);
