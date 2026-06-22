import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "CoolFix CRM",
  description: "Unified omnichannel customer inbox",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
