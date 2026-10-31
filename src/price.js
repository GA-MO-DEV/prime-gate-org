import { withVat } from "./money/vat.js";

export const total = (satang) => withVat(satang);

export const totalBaht = (satang) => total(satang) / 100;


export const totalSatang = (satang) => total(satang);
export const totalRounded = (satang) => Math.round(total(satang));
