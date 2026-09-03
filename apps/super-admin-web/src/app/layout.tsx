import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Flower SaaS — Super Admin',
  description: 'Platform control plane',
};

export const viewport: Viewport = {
  themeColor: '#db2777',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
