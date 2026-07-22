import { useState } from "preact/hooks";

// Per-island toast state (Astro pages mount several independent Preact
// islands, so there's no single global to share) — each top-level screen
// that needs one calls this itself, matching the design's floating bottom
// toast for one-off success confirmations.
export function useToast() {
  const [toast, setToast] = useState<string | null>(null);

  function show(message: string) {
    setToast(message);
    setTimeout(() => setToast((current) => (current === message ? null : current)), 2600);
  }

  return { toast, show };
}
