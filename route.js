import { getMeeting } from '@/lib/store';

const d = (x) => new Date(x).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const esc = (s) => String(s).replace(/([\;,])/g, '\\$1').replace(/\n/g, '\\n');

export async function GET(req, { params }) {
  const { code } = await params;
  const m = getMeeting(code);
  if (!m) return new Response('not found', { status: 404 });
  const host = req.headers.get('host') || '';
  if (!/^[a-z0-9.-]+(:\d+)?$/i.test(host)) return new Response('bad host', { status: 400 }); // no header injection into the .ics
  const proto = req.headers.get('x-forwarded-proto') === 'https' ? 'https' : 'http';
  const link = `${proto}://${host}/m/${m.id}`;
  const body = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Kestrel Meet//EN', 'BEGIN:VEVENT', `UID:${m.id}@kestrel-meet`,
    `DTSTAMP:${d(Date.now())}`, `DTSTART:${d(m.start)}`, `DTEND:${d(Date.parse(m.start) + m.duration * 60000)}`, `SUMMARY:${esc(m.title)}`,
    `DESCRIPTION:${esc(`Join: ${link}${m.passcode ? `\nPasscode: ${m.passcode}` : ''}`)}`, `URL:${link}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n') + '\r\n';
  return new Response(body, { headers: { 'content-type': 'text/calendar; charset=utf-8', 'content-disposition': `attachment; filename="${m.id}.ics"` } });
}
