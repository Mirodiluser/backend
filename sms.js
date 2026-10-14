// Разбор суммы из SMS банка.
// Понимает: "8 027 sum", "8,027.00 UZS", "8027 so'm", "8 027,00 сум", "+7990 сум".
// Берётся ПЕРВАЯ сумма в тексте (дальше может идти остаток на карте). Если сумма не целая
// (есть тийины) или это не платёж, возвращается null.
const AMOUNT_RE = /(\d{1,3}(?:[  ,.]\d{3})+|\d+)(?:[.,](\d{1,2}))?\s*(?:so['’ʻ‘`]?m|sum|сум|сўм|uzs)/i;

function parseSmsAmount(text) {
    if (typeof text !== 'string') return null;
    const match = text.match(AMOUNT_RE);
    if (!match) return null;

    const fraction = match[2];
    if (fraction && /[1-9]/.test(fraction)) return null;

    const amount = parseInt(match[1].replace(/[  ,.]/g, ''), 10);
    if (!Number.isSafeInteger(amount) || amount <= 0) return null;
    return amount;
}

module.exports = { parseSmsAmount };
