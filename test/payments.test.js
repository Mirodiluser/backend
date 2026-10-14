const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { startServer } = require('./helpers');

const HOOK_SECRET = 'test-hook-secret';
const PRICES = { pkg_15: 7990, pkg_50: 22990, pkg_100: 42990, pkg_250: 99990, pkg_500: 169990, pkg_1200: 309990 };
const COINS = { pkg_15: 15, pkg_50: 55, pkg_100: 115, pkg_250: 290, pkg_500: 580, pkg_1200: 1150 };

let srv;

test.before(async () => { srv = await startServer(); });
test.after(async () => { if (srv) await srv.stop(); });

const createOrder = (token, packageId) =>
    srv.request('POST', '/api/payment/create-order', { token, json: { packageId } });
const checkStatus = (token, orderId) =>
    srv.request('GET', `/api/payment/check-status/${encodeURIComponent(orderId)}`, { token });
const wallet = (user) => srv.request('GET', '/api/wallet', { token: user.token });
const sendSms = (text, secret = HOOK_SECRET) =>
    srv.request('POST', '/api/webhook/sms', {
        headers: secret === null ? {} : { 'x-webhook-secret': secret },
        json: { text }
    });
const smsFor = (amount) => `Kirim: +${String(amount).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} sum. Karta *2596`;

// ---------------- авторизация ----------------
test('без токена платёжные и кошелёчные эндпоинты возвращают 401', async () => {
    assert.equal((await srv.request('POST', '/api/payment/create-order', { json: { packageId: 'pkg_15' } })).status, 401);
    assert.equal((await srv.request('GET', '/api/payment/check-status/ord_x')).status, 401);
    assert.equal((await srv.request('GET', '/api/wallet')).status, 401);
    assert.equal((await srv.request('POST', '/api/check-file')).status, 401);
});

test('поддельные токены отклоняются, настоящий работает', async () => {
    const user = await srv.register('forge');
    const wrongSecret = jwt.sign({ id: user.id }, 'wrong-secret');
    assert.equal((await srv.request('GET', '/api/wallet', { token: wrongSecret })).status, 401);
    assert.equal((await srv.request('GET', '/api/wallet', { token: user.token + 'x' })).status, 401);
    assert.equal((await wallet(user)).status, 200);
});

test('эндпоинтов бесплатного начисления нет', async () => {
    const user = await srv.register('free');
    const res = await srv.request('POST', '/api/wallet/add-coins', {
        token: user.token, json: { userId: user.id, amount: 1000000 }
    });
    assert.equal(res.status, 404);
    assert.equal((await wallet(user)).data.coins, 15);
});

// ---------------- создание заказа ----------------
test('create-order: цена и монеты берутся с сервера; сумма в пределах «цена минус 1–99»', async () => {
    for (const pkgId of Object.keys(PRICES)) {
        const user = await srv.register('catalog');
        const res = await srv.request('POST', '/api/payment/create-order', {
            token: user.token,
            json: { packageId: pkgId, amount: 1, coins: 999999 } // поля клиента игнорируются
        });
        assert.equal(res.status, 200, pkgId);
        assert.equal(res.data.coins, COINS[pkgId], pkgId);
        assert.ok(res.data.amount >= PRICES[pkgId] - 99 && res.data.amount <= PRICES[pkgId] - 1, `${pkgId}: ${res.data.amount}`);
        assert.equal(res.data.expiresInSec, 900);

        // оплачиваем сразу: проверяем начисление и освобождаем слот суммы
        assert.equal((await sendSms(smsFor(res.data.amount))).status, 200, pkgId);
        assert.equal((await wallet(user)).data.coins, 15 + COINS[pkgId], pkgId);
    }
});

test('create-order: неизвестные пакеты и инъекции отклоняются', async () => {
    const user = await srv.register('inject');
    for (const bad of ['pkg_999', "x'; DROP TABLE orders;--", '', null, 42, {}, '__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
        const res = await createOrder(user.token, bad);
        assert.equal(res.status, 400, `packageId=${JSON.stringify(bad)}`);
    }
    assert.equal((await createOrder(user.token, 'pkg_15')).status, 200);
});

test('create-order: суммы активных заказов не повторяются, платёж засчитывается только плательщику', async () => {
    const a = await srv.register('twinA');
    const b = await srv.register('twinB');
    const orderA = await createOrder(a.token, 'pkg_100');
    const orderB = await createOrder(b.token, 'pkg_100');
    assert.notEqual(orderA.data.amount, orderB.data.amount);

    const res = await sendSms(smsFor(orderB.data.amount));
    assert.equal(res.data.userId, b.id);
    assert.equal((await wallet(b)).data.coins, 15 + 115);
    assert.equal((await wallet(a)).data.coins, 15);
    assert.equal((await checkStatus(a.token, orderA.data.orderId)).data.status, 'PENDING');
    assert.equal((await checkStatus(b.token, orderB.data.orderId)).data.status, 'PAID');
});

// ---------------- статус ----------------
test('check-status: виден только владельцу, неизвестные заказы — 404', async () => {
    const owner = await srv.register('owner');
    const other = await srv.register('other');
    const order = await createOrder(owner.token, 'pkg_15');

    const mine = await checkStatus(owner.token, order.data.orderId);
    assert.equal(mine.status, 200);
    assert.equal(mine.data.status, 'PENDING');
    assert.equal(mine.data.coins, 15);
    assert.ok(mine.data.expiresInSec > 0 && mine.data.expiresInSec <= 900);

    assert.equal((await checkStatus(other.token, order.data.orderId)).status, 404);
    assert.equal((await checkStatus(owner.token, 'ord_doesnotexist')).status, 404);
    assert.equal((await checkStatus(owner.token, "x' OR '1'='1")).status, 404);
});

// ---------------- вебхук ----------------
test('вебхук: без секрета и с неверным секретом — 401, монеты не начисляются', async () => {
    const user = await srv.register('hookauth');
    const order = await createOrder(user.token, 'pkg_15');
    assert.equal((await sendSms(smsFor(order.data.amount), null)).status, 401);
    assert.equal((await sendSms(smsFor(order.data.amount), 'nope')).status, 401);
    const viaQuery = await srv.request('POST', '/api/webhook/sms?secret=nope', { json: { text: smsFor(order.data.amount) } });
    assert.equal(viaQuery.status, 401);
    assert.equal((await checkStatus(user.token, order.data.orderId)).data.status, 'PENDING');
    assert.equal((await wallet(user)).data.coins, 15);
});

test('вебхук: секрет можно передать в ?secret=', async () => {
    const user = await srv.register('querysecret');
    const order = await createOrder(user.token, 'pkg_15');
    const res = await srv.request('POST', `/api/webhook/sms?secret=${HOOK_SECRET}`, { json: { text: smsFor(order.data.amount) } });
    assert.equal(res.data.success, true);
});

test('вебхук: SMS без суммы и без подходящего заказа не меняют баланс', async () => {
    const user = await srv.register('hookmiss');
    const order = await createOrder(user.token, 'pkg_15');
    assert.equal((await sendSms('Kod tasdiqlash: 123456')).status, 400);
    assert.equal((await sendSms(smsFor(500))).status, 404);
    assert.equal((await srv.request('POST', '/api/webhook/sms', { headers: { 'x-webhook-secret': HOOK_SECRET }, json: {} })).status, 400);
    assert.equal((await checkStatus(user.token, order.data.orderId)).data.status, 'PENDING');
    assert.equal((await wallet(user)).data.coins, 15);
});

test('вебхук: заказ оплачен, монеты начислены ровно один раз (в том числе при параллельных повторах)', async () => {
    const user = await srv.register('payer');
    const order = await createOrder(user.token, 'pkg_50');

    const results = await Promise.all(Array.from({ length: 5 }, () => sendSms(smsFor(order.data.amount))));
    assert.equal(results.filter((r) => r.data.success === true).length, 1);

    const status = await checkStatus(user.token, order.data.orderId);
    assert.equal(status.data.status, 'PAID');
    assert.equal(status.data.coins, 55);

    const w = await wallet(user);
    assert.equal(w.data.coins, 15 + 55);
    assert.equal(w.data.totalPurchased, 15 + 55);

    assert.equal((await sendSms(smsFor(order.data.amount))).status, 404); // позднее повторение
    assert.equal((await wallet(user)).data.coins, 15 + 55);
});

test('вебхук: разные форматы SMS (so\'m, UZS, копейки, разделители)', async () => {
    const withSpaces = (a) => String(a).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    const formats = [
        (a) => `Kirim +${a} so'm`,
        (a) => `Kirim +${a} UZS`,
        (a) => `Kirim +${a}.00 sum`,
        (a) => `Kirim +${withSpaces(a)},00 сум`,
        (a) => `Kirim +${withSpaces(a)} sum. Balans: 1 250 000 sum`
    ];
    for (const make of formats) {
        const user = await srv.register('fmt');
        const order = await createOrder(user.token, 'pkg_15');
        const text = make(order.data.amount);
        const res = await sendSms(text);
        assert.equal(res.status, 200, text);
        assert.equal((await wallet(user)).data.coins, 30, text);
    }
});

test('вебхук отключён (503), если SMS_WEBHOOK_SECRET не задан на сервере', async () => {
    const noSecretSrv = await startServer({ SMS_WEBHOOK_SECRET: undefined });
    try {
        const res = await noSecretSrv.request('POST', '/api/webhook/sms', {
            headers: { 'x-webhook-secret': '' }, json: { text: smsFor(8000) }
        });
        assert.equal(res.status, 503);
    } finally {
        await noSecretSrv.stop();
    }
});

// ---------------- списание за проверку файла ----------------
test('check-file: неподдерживаемый формат отклоняется до списания монет', async () => {
    const user = await srv.register('fmtcheck');
    const fd = new FormData();
    fd.append('document', new Blob(['MZ...']), 'virus.exe');
    assert.equal((await srv.request('POST', '/api/check-file', { token: user.token, body: fd })).status, 400);
    const w = await wallet(user);
    assert.equal(w.data.coins, 15);
    assert.equal(w.data.totalSpent, 0);
});

test('check-file: при ошибке обработки монеты возвращаются', async () => {
    const user = await srv.register('refund');
    const fd = new FormData();
    fd.append('document', new Blob(['это не настоящий docx']), 'broken.docx');
    assert.equal((await srv.request('POST', '/api/check-file', { token: user.token, body: fd })).status, 500);
    assert.equal((await wallet(user)).data.coins, 15);
});

test('check-file: userId из формы игнорируется — списывается с владельца токена', async () => {
    const victim = await srv.register('victim');
    const attacker = await srv.register('attacker');
    const fd = new FormData();
    fd.append('document', new Blob(['x']), 'broken.docx');
    fd.append('userId', String(victim.id));
    await srv.request('POST', '/api/check-file', { token: attacker.token, body: fd });
    const w = await wallet(victim);
    assert.equal(w.data.coins, 15);
    assert.equal(w.data.totalTransactions, 1); // только бонус за регистрацию
});
