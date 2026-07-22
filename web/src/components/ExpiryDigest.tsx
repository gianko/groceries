import { actions } from "astro:actions";
import { useState } from "preact/hooks";
import type { DigestLot } from "../../../src/digest.js";
import { useAutoRelistOffers } from "../lib/autoRelistOffers";
import { useToast } from "../lib/toast";
import AutoRelistPanel from "./AutoRelistPanel";

interface Props {
  expiringSoon: DigestLot[];
  justExpired: DigestLot[];
}

export default function ExpiryDigest({ expiringSoon, justExpired }: Props) {
  const [expired, setExpired] = useState(justExpired);
  const [notice, setNotice] = useState<string | null>(null);
  const { offers, addOffers, decideOffer } = useAutoRelistOffers();
  const { toast, show: showToast } = useToast();

  async function markGone(lotId: number) {
    const { data, error } = await actions.digest.markGone({ lotId });
    if (error) {
      setNotice("Couldn't reach the server — nothing was confirmed. Try again.");
      return;
    }

    // A lost race (already resolved elsewhere) reports finished: false —
    // the row just closes silently, same as decideOffer below.
    setExpired((prev) => prev.filter((lot) => lot.lotId !== lotId));
    showToast("Marked gone");
    if (data.offerAutoRelist && data.productId !== null && data.productName !== null) {
      addOffers([{ productId: data.productId, productName: data.productName }]);
    }
  }

  async function markStillGood(lotId: number) {
    const { error } = await actions.digest.markStillGood({ lotId });
    if (error) {
      setNotice("Couldn't reach the server — nothing was confirmed. Try again.");
      return;
    }

    setExpired((prev) => prev.filter((lot) => lot.lotId !== lotId));
    showToast("Kept — still good");
  }

  if (expiringSoon.length === 0 && expired.length === 0 && offers.length === 0) {
    return null;
  }

  return (
    <div>
      {notice && <div class="notice">{notice}</div>}

      <AutoRelistPanel offers={offers} onDecide={decideOffer} />

      {expired.length > 0 && (
        <section>
          <h2 class="section-head">🔺 Just expired — gone or still good?</h2>
          <ul class="signal-list signal-list--cards">
            {expired.map((lot) => (
              <li class="signal-card expiring confirm" key={lot.lotId}>
                <div class="signal-body">
                  <span class="signal-title">{lot.productName}</span>
                  <span class="signal-meta">
                    {lot.unit ? `${lot.quantity} ${lot.unit}` : lot.quantity} · exp {lot.estExpiry}
                  </span>
                </div>
                <div class="signal-actions">
                  <button
                    type="button"
                    class="pill-btn good"
                    onClick={() => markStillGood(lot.lotId)}
                  >
                    ✅ Still good
                  </button>
                  <button type="button" class="pill-btn gone" onClick={() => markGone(lot.lotId)}>
                    🗑️ Gone
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {expiringSoon.length > 0 && (
        <section>
          <h2 class="section-head">🕒 Expiring soon</h2>
          <ul class="signal-list">
            {expiringSoon.map((lot) => (
              <li class="signal-card expiring" key={lot.lotId}>
                <div class="signal-body">
                  <span class="signal-title">{lot.productName}</span>
                  <span class="signal-meta">
                    {lot.unit ? `${lot.quantity} ${lot.unit}` : lot.quantity} · exp {lot.estExpiry}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {toast && <div class="toast">{toast}</div>}
    </div>
  );
}
