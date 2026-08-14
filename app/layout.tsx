import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Trello Auto Claim',
  description: 'Automatically claims eligible, unclaimed Trello cards from the To Do list.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: 'system-ui, sans-serif' }}>{children}</body>
    </html>
  );
}
