import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "CoolFix CRM",
  description: "Unified omnichannel customer inbox",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "CoolFix CRM",
    statusBarStyle: "default",
  },
  icons: {
    apple: "/mobile-icon.svg",
    icon: "/mobile-icon.svg",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
