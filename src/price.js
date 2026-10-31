import { withVat } from "./money/vat.js";

export const total = (satang) => withVat(satang);

export const coupon = (satang, pct) => Math.round(satang * (100 - pct) / 100);
