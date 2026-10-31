export const withVat = (satang) => Math.round((satang * 107) / 100);

export const vatOnly = (satang) => withVat(satang) - satang;
