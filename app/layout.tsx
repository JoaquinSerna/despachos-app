import type { Metadata } from "next";
import { Barlow } from "next/font/google";
import "./globals.css";

const barlow = Barlow({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  variable: "--font-barlow",
  display: "swap",
});

const envName = process.env.NEXT_PUBLIC_ENV_NAME

export const metadata: Metadata = {
  title: envName ? `Despachos — CAC [${envName}]` : "Despachos — CAC",
  description: "Sistema de gestión de despachos y entregas",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es">
      <body className={`${barlow.variable} antialiased`} style={{ fontFamily: 'Barlow, sans-serif' }}>
        {children}
      </body>
    </html>
  );
}
