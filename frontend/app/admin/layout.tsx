import type { ReactNode } from "react";

export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <div style={{ padding: "2rem" }}>
      <header>
        <h1>Admin Panel</h1>
        <p style={{ color: "var(--muted)" }}>
          This area is restricted to maintainers.
        </p>
      </header>
      <main>{children}</main>
    </div>
  );
}
