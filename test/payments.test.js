const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { startServer } = require('./helpers');

const WEBHOOK_SECRET = 'test-hook-secret';

let srv;

test.before(async () => {
    srv = await startServer();
});

test.after(async () => {
    if (srv) await srv.stop();
});

// ---- вспомогательные функции ----
const createOrder = (token, packageId, extra = {}) =>
    srv.request('POST', '/api/payment/create-order', { token, json: { packageId, ...extra } });

const checkStatus = (token, orderId) =>
    srv.request('GET', `/api/payment/check-status/${encodeURIComponent(orderId)}`, { token });

const wallet = (user) => srv.request('GET', `/api/wallet/${user.id}`, { token: user.token });

const sendSms = (text, { secret = WEBHOOK_SECRET } = {}) =>
    srv.request('POST', '/api/webhook/sms', {
        headers: secret === null ? {} : { 'x-webhook-secret': secret },
        json: { text }
    });

const smsFor = (amount) => `Kirim: +${String(amount).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} sum. Karta *2596`;

// ============================================================
// Авторизация: платёжные и кошелёчные эндпоинты закрыты
// ============================================================
test('без токена платёжные и кошелёчные эндпоинты возвращают 401', async () => {
    assert.equal((await srv.request('POST', '/api/payment/create-order', { json: { packageId: 'pkg_15' } })).status, 401);
    assert.equal((await srv.request('GET', '/api/payment/check-status/ord_abc')).status, 401);
    assert.equal((await srv.request('GET', '/api/wallet/1')).status, 401);
    assert.equal((await srv.request('GET', '/api/auth/me/1')).status, 401);
    assert.equal((await srv.request('POST', '/api/check-file')).status, 401);
});

test('поддельные токены отклоняются (в том числе подписанный старым зашитым секретом)', async () => {
    const user = await srv.register('forge');

    const wrongSecret = jwt.sign({ id: user.id }, 'wrong-secret');
    assert.equal((await srv.request('GET', `/api/wallet/${user.id}`, { token: wrongSecret })).status, 401);

    const oldHardcoded = jwt.sign({ id: user.id }, 'tahrir_ai_jwt_secret_key_2026');
    assert.equal((await srv.request('GET', `/api/wallet/${user.id}`, { token: oldHardcoded })).status, 401);

    const ghostUser = jwt.sign({ id: 999999 }, 'test-jwt-secret');
    assert.equal((await srv.request('GET', `/api/wallet/999999`, { token: ghostUser })).status, 401);

    assert.equal((await srv.request('GET', `/api/wallet/${user.id}`, { token: user.token + 'x' })).status, 401);
    assert.equal((await srv.request('GET', `/api/wallet/${user.id}`, { token: user.token })).status, 200);
});

test('чужой кошелёк недоступен (403), эндпоинтов бесплатного начисления больше нет', async () => {
    const a = await srv.register('walletA');
    const b = await srv.register('walletB');

    assert.equal((await srv.request('GET', `/api/wallet/${b.id}`, { token: a.token })).status, 403);
    assert.equal((await srv.request('GET', `/api/auth/me/${b.id}`, { token: a.token })).status, 403);

    const free = await srv.request('POST', '/api/wallet/add-coins', {
        token: a.token,
        json: { userId: a.id, amount: 1000000, package: 'hack' }
    });
    assert.equal(free.status, 404);
    const spend = await srv.request('POST', '/api/wallet/spend-coins', {
        token: a.token,
        json: { userId: b.id, amount: 5 }
    });
    assert.equal(spend.status, 404);

    assert.equal((await wallet(a)).data.coins, 15);
    assert.equal((await wallet(b)).data.coins, 15);
});

// ============================================================
// Создание заказа
// ============================================================
test('create-order: цена и монеты берутся с сервера, поля клиента игнорируются', async () => {
    const user = await srv.register('buyer');
    const res = await createOrder(user.token, 'pkg_15', { amount: 1, coins: 999999, userId: 1 });

    assert.equal(res.status, 200);
    assert.equal(res.data.success, true);
    assert.match(res.data.orderId, /^ord_[a-f0-9]{24}$/);
    assert.equal(res.data.baseAmount, 7990);
    assert.ok(res.data.amount >= 7991 && res.data.amount <= 8089, `amount ${res.data.amount}`);
    assert.equal(res.data.coins, 15);
    assert.equal(res.data.status, 'PENDING');
    assert.ok(res.data.expiresInSec > 1700 && res.data.expiresInSec <= 1800);
});

test('create-order: суммы и монеты всех пакетов совпадают с каталогом', async () => {
    const expected = {
        pkg_15: [7990, 15],
        pkg_50: [22990, 55],
        pkg_100: [42990, 115],
        pkg_250: [99990, 290],
        pkg_500: [169990, 580],
        pkg_1200: [309990, 1150]
    };
    for (const [pkgId, [price, coins]] of Object.entries(expected)) {
        const user = await srv.register('catalog');
        const res = await createOrder(user.token, pkgId);
        assert.equal(res.status, 200, pkgId);
        assert.equal(res.data.coins, coins, pkgId);
        assert.ok(res.data.amount > price && res.data.amount <= price + 99, `${pkgId}: ${res.data.amount}`);

        // сразу оплачиваем: проверяем начисление и освобождаем слот суммы
        const paid = await sendSms(smsFor(res.data.amount));
        assert.equal(paid.data.success, true, pkgId);
        assert.equal((await wallet(user)).data.coins, 15 + coins, pkgId);
    }
});

test('create-order: неизвестный пакет и SQL-инъекции отклоняются', async () => {
    const user = await srv.register('inject');
    for (const bad of ['pkg_999', "x'; DROP TABLE orders;--", '', null, 42, {}, ['pkg_15'], '__proto__', 'constructor']) {
        const res = await createOrder(user.token, bad);
        assert.equal(res.status, 400, `packageId=${JSON.stringify(bad)}`);
    }
    // сервер жив, таблица на месте
    assert.equal((await createOrder(user.token, 'pkg_15')).status, 200);
});

test('create-order: повторный запрос на тот же пакет возвращает тот же заказ', async () => {
    const user = await srv.register('idem');
    const first = await createOrder(user.token, 'pkg_50');
    const second = await createOrder(user.token, 'pkg_50');
    assert.equal(first.data.orderId, second.data.orderId);
    assert.equal(first.data.amount, second.data.amount);
});

test('create-order: не больше 3 неоплаченных заказов на пользователя', async () => {
    const user = await srv.register('cap');
    assert.equal((await createOrder(user.token, 'pkg_15')).status, 200);
    assert.equal((await createOrder(user.token, 'pkg_50')).status, 200);
    assert.equal((await createOrder(user.token, 'pkg_100')).status, 200);
    const fourth = await createOrder(user.token, 'pkg_250');
    assert.equal(fourth.status, 429);
    assert.ok(fourth.data.error);
});

// ============================================================
// Статус заказа
// ============================================================
test('check-status: виден только владельцу, неизвестные заказы — 404', async () => {
    const owner = await srv.register('owner');
    const other = await srv.register('other');
    const order = await createOrder(owner.token, 'pkg_15');

    const mine = await checkStatus(owner.token, order.data.orderId);
    assert.equal(mine.status, 200);
    assert.equal(mine.data.status, 'PENDING');
    assert.equal(mine.data.amount, order.data.amount);

    assert.equal((await checkStatus(other.token, order.data.orderId)).status, 404);
    assert.equal((await checkStatus(owner.token, 'ord_doesnotexist')).status, 404);
    assert.equal((await checkStatus(owner.token, "x' OR '1'='1")).status, 404);
});

// ============================================================
// Вебхук SMS
// ============================================================
test('вебхук: без секрета и с неверным секретом — 401, монеты не начисляются', async () => {
    const user = await srv.register('hookauth');
    const order = await createOrder(user.token, 'pkg_15');

    assert.equal((await sendSms(smsFor(order.data.amount), { secret: null })).status, 401);
    assert.equal((await sendSms(smsFor(order.data.amount), { secret: 'nope' })).status, 401);
    const viaQuery = await srv.request('POST', '/api/webhook/sms?secret=nope', { json: { text: smsFor(order.data.amount) } });
    assert.equal(viaQuery.status, 401);

    assert.equal((await checkStatus(user.token, order.data.orderId)).data.status, 'PENDING');
    assert.equal((await wallet(user)).data.coins, 15);
});

test('вебхук: SMS без суммы и SMS без подходящего заказа игнорируются', async () => {
    const user = await srv.register('hookmiss');
    const order = await createOrder(user.token, 'pkg_15');

    const noAmount = await sendSms('Kod tasdiqlash: 123456');
    assert.equal(noAmount.status, 200);
    assert.equal(noAmount.data.success, false);
    assert.equal(noAmount.data.reason, 'amount_not_found');

    const unmatched = await sendSms(smsFor(12345));
    assert.equal(unmatched.status, 200);
    assert.equal(unmatched.data.success, false);
    assert.equal(unmatched.data.reason, 'no_matching_order');

    assert.equal((await srv.request('POST', '/api/webhook/sms', { headers: { 'x-webhook-secret': WEBHOOK_SECRET }, json: {} })).status, 400);

    assert.equal((await checkStatus(user.token, order.data.orderId)).data.status, 'PENDING');
    assert.equal((await wallet(user)).data.coins, 15);
});

test('вебхук: нет «нечёткого» совпадения — цена пакета без надбавки и соседние суммы не засчитываются', async () => {
    const user = await srv.register('nofuzzy');
    const order = await createOrder(user.token, 'pkg_250');
    const amount = order.data.amount;

    // Голая цена пакета, сумма на 1 меньше/больше — не должны засчитаться
    for (const wrong of [99990, amount + 100, amount - 100]) {
        const res = await sendSms(smsFor(wrong));
        assert.equal(res.data.success, false, `сумма ${wrong}`);
    }
    assert.equal((await checkStatus(user.token, order.data.orderId)).data.status, 'PENDING');
    assert.equal((await wallet(user)).data.coins, 15);
});

test('вебхук: точная сумма — заказ оплачен, монеты начислены ровно один раз', async () => {
    const user = await srv.register('payer');
    const order = await createOrder(user.token, 'pkg_50');

    const paid = await sendSms(smsFor(order.data.amount));
    assert.equal(paid.status, 200);
    assert.equal(paid.data.success, true);
    assert.equal(paid.data.userId, user.id);
    assert.equal(paid.data.coinsAdded, 55);

    const status = await checkStatus(user.token, order.data.orderId);
    assert.equal(status.data.status, 'PAID');
    assert.equal(status.data.coins, 55);

    const w = await wallet(user);
    assert.equal(w.data.coins, 15 + 55);
    assert.equal(w.data.totalPurchased, 15 + 55);

    // повторная доставка того же SMS ничего не меняет
    const replay = await sendSms(smsFor(order.data.amount));
    assert.equal(replay.data.success, false);
    assert.equal((await wallet(user)).data.coins, 15 + 55);
    assert.equal((await checkStatus(user.token, order.data.orderId)).data.status, 'PAID');
});

test('вебхук: принимает JSON с другими именами поля, form-urlencoded и text/plain', async () => {
    const formats = [
        (text) => ({ json: { message: text } }),
        (text) => ({ json: { body: text } }),
        (text) => ({ headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `text=${encodeURIComponent(text)}` }),
        (text) => ({ headers: { 'Content-Type': 'text/plain' }, body: text })
    ];
    for (const build of formats) {
        const user = await srv.register('fmt');
        const order = await createOrder(user.token, 'pkg_15');
        const opts = build(smsFor(order.data.amount));
        const res = await srv.request('POST', '/api/webhook/sms', {
            ...opts,
            headers: { ...(opts.headers || {}), 'x-webhook-secret': WEBHOOK_SECRET }
        });
        assert.equal(res.data.success, true, JSON.stringify(opts));
        assert.equal((await wallet(user)).data.coins, 30);
    }
});

test('вебхук: секрет можно передать в ?secret=', async () => {
    const user = await srv.register('querysecret');
    const order = await createOrder(user.token, 'pkg_15');
    const res = await srv.request('POST', `/api/webhook/sms?secret=${WEBHOOK_SECRET}`, { json: { text: smsFor(order.data.amount) } });
    assert.equal(res.data.success, true);
});

test('два пользователя с одним пакетом получают разные суммы; платёж засчитывается только плательщику', async () => {
    const a = await srv.register('twinA');
    const b = await srv.register('twinB');
    const orderA = await createOrder(a.token, 'pkg_100');
    const orderB = await createOrder(b.token, 'pkg_100');

    assert.notEqual(orderA.data.amount, orderB.data.amount);

    const res = await sendSms(smsFor(orderB.data.amount));
    assert.equal(res.data.success, true);
    assert.equal(res.data.userId, b.id);

    assert.equal((await wallet(b)).data.coins, 15 + 115);
    assert.equal((await wallet(a)).data.coins, 15);
    assert.equal((await checkStatus(a.token, orderA.data.orderId)).data.status, 'PENDING');
    assert.equal((await checkStatus(b.token, orderB.data.orderId)).data.status, 'PAID');
});

test('суммы активных заказов никогда не повторяются; когда слоты кончились — 429', async () => {
    // pkg_500 больше нигде в тестах не используется: занимаем все 99 слотов (+1..+99)
    const amounts = new Set();
    const users = [];
    for (let i = 0; i < 99; i++) users.push(await srv.register('slot'));

    const results = await Promise.all(users.map((u) => createOrder(u.token, 'pkg_500')));
    for (const res of results) {
        assert.equal(res.status, 200);
        assert.ok(!amounts.has(res.data.amount), `повторилась сумма ${res.data.amount}`);
        amounts.add(res.data.amount);
    }
    assert.equal(amounts.size, 99);

    const late = await srv.register('slot_late');
    const overflow = await createOrder(late.token, 'pkg_500');
    assert.equal(overflow.status, 429);

    // после оплаты одного заказа слот освобождается
    const paidAmount = results[0].data.amount;
    assert.equal((await sendSms(smsFor(paidAmount))).data.success, true);
    const retry = await createOrder(late.token, 'pkg_500');
    assert.equal(retry.status, 200);
    assert.equal(retry.data.amount, paidAmount);
});

test('вебхук отключён (503), если WEBHOOK_SECRET не задан на сервере', async () => {
    const noSecretSrv = await startServer({ WEBHOOK_SECRET: undefined });
    try {
        const res = await noSecretSrv.request('POST', '/api/webhook/sms', {
            headers: { 'x-webhook-secret': '' },
            json: { text: smsFor(8000) }
        });
        assert.equal(res.status, 503);
        const res2 = await noSecretSrv.request('POST', '/api/webhook/sms', {
            headers: { 'x-webhook-secret': 'anything' },
            json: { text: smsFor(8000) }
        });
        assert.equal(res2.status, 503);
    } finally {
        await noSecretSrv.stop();
    }
});

// ============================================================
// Списание монет за проверку файла
// ============================================================
test('check-file: неподдерживаемый формат отклоняется до списания монет', async () => {
    const user = await srv.register('fmtcheck');
    const fd = new FormData();
    fd.append('document', new Blob(['MZ...']), 'virus.exe');
    const res = await srv.request('POST', '/api/check-file', { token: user.token, body: fd });
    assert.equal(res.status, 400);
    const w = await wallet(user);
    assert.equal(w.data.coins, 15);
    assert.equal(w.data.totalSpent, 0);
});

test('check-file: при ошибке обработки списанные монеты возвращаются', async () => {
    const user = await srv.register('refund');
    const fd = new FormData();
    fd.append('document', new Blob(['это не настоящий docx']), 'broken.docx');
    const res = await srv.request('POST', '/api/check-file', { token: user.token, body: fd });
    assert.equal(res.status, 500);

    const w = await wallet(user);
    assert.equal(w.data.coins, 15, 'монеты должны вернуться');
    assert.equal(w.data.totalSpent, 0);
    const types = w.data.transactions.map((t) => t.type);
    assert.ok(types.includes('spend') && types.includes('refund'), `транзакции: ${types}`);
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
    assert.equal(w.data.totalSpent, 0);
    assert.equal(w.data.totalTransactions, 1); // только бонус за регистрацию
});
