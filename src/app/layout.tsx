import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Doott Data Bot",
  description: "Internal chatbot to pull records from the Doott database",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
