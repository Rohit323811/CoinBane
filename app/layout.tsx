import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";

import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  title: "CoinBane — Command every coin.",
  description:
    "CoinBane is an AI financial operations agent for freelancers. It runs PayPal invoices, watches for late payments and disputes, and shows you the leaks in natural language.",
};

export const viewport: Viewport = {
  themeColor: "#080A0F",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={inter.variable}>
      {/*
       * Deliberately no coin here: the shell wraps every route, so a mark
       * mounted in the layout would appear everywhere. The coin belongs to the
       * PayPal landing page alone — the doorway *out* of it — and app/paypal/
       * page.tsx mounts it. The chat has its own microphone button.
       */}
      <body className="font-sans">{children}</body>
    </html>
  );
}
