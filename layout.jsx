import './globals.css';
import '@livekit/components-styles';

export const metadata = { title: 'Kestrel Meet', description: 'Video meetings, webinars and breakout rooms.' };

export default function RootLayout({ children }) {
  return (<html lang="en"><body>{children}</body></html>);
}
