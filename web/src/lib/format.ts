export function fmtQty(quantity: number, unit: string | null): string {
  return unit ? `${quantity} ${unit}` : `${quantity}`;
}
