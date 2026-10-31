import { withVat } from "./money/vat.js";

export const total = (satang) => withVat(satang);

export const totalBaht = (satang) => total(satang) / 100;


// rt skip-ci probe: unapproved change (fake)
export const rtSkip = 1;
