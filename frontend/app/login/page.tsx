import type { Metadata } from "next";
import { LoginPageClient } from "./LoginPageClient";

export const metadata: Metadata = {
  title: "Login - StellarCred",
  description:
    "Sign in to StellarCred with your Stellar wallet or credentials. Secure, decentralized, and zero-knowledge.",
};

export default function LoginPage() {
  return <LoginPageClient />;
}
