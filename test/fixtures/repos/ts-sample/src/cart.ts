/** Cart totals. */
export interface Item {
  sku: string;
  price: number;
}

export type Currency = "GBP" | "EUR";

export enum Rounding {
  Up,
  Down,
}

export async function cartTotal<T extends Item>(items: T[], discountPct: number): Promise<number> {
  const sum = (xs: T[]) => xs.reduce((a, x) => a + x.price, 0);
  function applyDiscount(v: number): number {
    return v * (1 - discountPct / 100);
  }
  return applyDiscount(sum(items));
}

export const round = (v: number, mode: Rounding = Rounding.Up): number => (mode === Rounding.Up ? Math.ceil(v) : Math.floor(v));

export function formatPrice(
  value: number,
  currency: Currency,
  locale: string = "en-GB",
): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(value);
}

export default class Cart {
  private items: Item[] = [];

  add(item: Item): void {
    this.items.push(item);
  }

  total(): Promise<number> {
    return cartTotal(this.items, 0);
  }
}
