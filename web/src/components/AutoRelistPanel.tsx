import type { AutoRelistOffer } from "../lib/autoRelistOffers";

interface Props {
  offers: AutoRelistOffer[];
  onDecide: (productId: number, wantsAutoRelist: boolean) => void;
}

export default function AutoRelistPanel({ offers, onDecide }: Props) {
  if (offers.length === 0) {
    return null;
  }

  return (
    <div class="auto-relist-panel">
      <p class="auto-relist-title">Always re-add these when they run out?</p>
      {offers.map((offer) => (
        <div class="auto-relist-row" key={offer.productId}>
          <span>{offer.productName}</span>
          <div class="auto-relist-actions">
            <button type="button" onClick={() => onDecide(offer.productId, true)}>
              Yes
            </button>
            <button type="button" onClick={() => onDecide(offer.productId, false)}>
              No
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
