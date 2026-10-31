import { withVat } from "./money/vat.js";

export const total = (satang) => withVat(satang);
