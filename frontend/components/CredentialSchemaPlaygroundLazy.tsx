"use client";

import dynamic from "next/dynamic";

const CredentialSchemaPlayground = dynamic(
  () => import("@/components/CredentialSchemaPlayground"),
  {
    ssr: false,
    loading: () => (
      <div
        style={{
          padding: "2rem 0",
          color: "var(--muted)",
          textAlign: "center",
        }}
      >
        Loading credential schema playground…
      </div>
    ),
  },
);

export default CredentialSchemaPlayground;
