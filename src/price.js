import { withVat } from "./money/vat.js";

export const total = (satang) => withVat(satang);

export const totalBaht = (satang) => total(satang) / 100;


// rt spoof target: unapproved change (fake)
export const rtSpoof = 1;
