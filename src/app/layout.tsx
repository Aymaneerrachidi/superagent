import type { Metadata, Viewport } from "next";
// Self-hosted: no CDN request, no layout shift, works under the strict CSP.
import "@fontsource/instrument-serif/400.css";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./globals.css";

export const metadata: Metadata = {
  title: "Why Is This Pumping?",
  description: "Analyze a Solana, Base, BNB Chain, or Robinhood Chain contract and find out why it's moving.",
};

export const viewport: Viewport = {
  themeColor: "#0a0a0d",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
