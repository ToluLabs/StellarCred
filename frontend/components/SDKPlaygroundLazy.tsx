"use client";

// Next 15+ forbids `next/dynamic` with `ssr: false` inside Server Components,
// so the /developers page's playground lazy-load lives in this client wrapper
// instead of app/developers/page.tsx. Same split behaviour: the SDKPlayground
// chunk is only fetched (and never server-rendered) in the browser.
import dynamic from "next/dynamic";

const SDKPlayground = dynamic(() => import("@/components/SDKPlayground"), {
  ssr: false,
  loading: () => (
    <div style={{ padding: "2rem 0", color: "var(--muted)", textAlign: "center" }}>
      Loading playground…
    </div>
  ),
});

export default SDKPlayground;
