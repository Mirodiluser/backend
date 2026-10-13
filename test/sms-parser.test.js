process.env.JWT_SECRET = 'test-jwt-secret';
process.env.DB_PATH = require('node:os').tmpdir() + '/sms-parser-unused.db';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSmsAmount } = require('../payments');

test('parseSmsAmount: разные форматы сумм', () => {
    const cases = [
        ['Karta *2596: +8 027 sum', 8027],
        ['Перевод: 8 027,00 сум. Баланс: 150 000 сум', 8027],
        ['Popolnenie 8,027.00 UZS', 8027],
        ['Kirim: 22990 so\'m', 22990],
        ['Kirim: 22990 so‘m', 22990],
        ['+7990 сум', 7990],
        ['1 234 567 sum', 1234567],
        ['1.234.567 sum', 1234567],
        ['Summa: 8027sum', 8027],
        ['Karta 2596 7990 sum', 7990] // номер карты не склеивается с суммой
    ];
    for (const [text, expected] of cases) {
        assert.equal(parseSmsAmount(text), expected, `текст: ${text}`);
    }
});

test('parseSmsAmount: не платёж или нецелая сумма — null', () => {
    assert.equal(parseSmsAmount('Kod: 123456'), null);
    assert.equal(parseSmsAmount('Salom! Aksiya 50% chegirma'), null);
    assert.equal(parseSmsAmount('8027.50 sum'), null);
    assert.equal(parseSmsAmount('0 sum'), null);
    assert.equal(parseSmsAmount(''), null);
    assert.equal(parseSmsAmount(undefined), null);
    assert.equal(parseSmsAmount({ text: '8027 sum' }), null);
});

test('parseSmsAmount: берётся первая сумма (а не баланс)', () => {
    assert.equal(parseSmsAmount('Kirim 8027 sum. Balans 999999 sum'), 8027);
});
