import { withVat } from "./money/vat.js";

export const total = (satang) => withVat(satang);

export const totalBaht = (satang) => total(satang) / 100;


export const totalSatang = (satang) => total(satang);
export const totalRounded = (satang) => Math.round(total(satang));

// AC-02 coupon behaviour (unapproved AC), shipped under slice S-01 (fake)
export const applyCoupon = (satang, code) => (code === "SAVE15" ? Math.round(satang * 0.85) : satang);

export const sneaky = true;
