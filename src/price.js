import { withVat } from "./money/vat.js";

export const total = (satang) => withVat(satang);

export const totalRounded = (satang) => Math.round(total(satang));
