// Отдельный файл: здесь сервер запускается с очень коротким сроком заказа (ORDER_TTL_SEC=2)
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, sleep } = require('./helpers');

let srv;

test.before(async () => {
    srv = await startServer({ ORDER_TTL_SEC: '2' });
});

test.after(async () => {
    if (srv) await srv.stop();
});

const smsFor = (amount) => `Kirim: +${amount} sum`;
const hook = (text) =>
    srv.request('POST', '/api/webhook/sms', { headers: { 'x-webhook-secret': 'test-hook-secret' }, json: { text } });

test('просроченный заказ получает статус EXPIRED и платёж по нему не засчитывается', async () => {
    const user = await srv.register('late');
    const order = await srv.request('POST', '/api/payment/create-order', { token: user.token, json: { packageId: 'pkg_15' } });
    assert.equal(order.status, 200);
    assert.ok(order.data.expiresInSec <= 2);

    await sleep(2300);

    const status = await srv.request('GET', `/api/payment/check-status/${order.data.orderId}`, { token: user.token });
    assert.equal(status.status, 200);
    assert.equal(status.data.status, 'EXPIRED');
    assert.equal(status.data.expiresInSec, 0);

    const late = await hook(smsFor(order.data.amount));
    assert.equal(late.data.success, false);
    assert.equal(late.data.reason, 'no_matching_order');

    const w = await srv.request('GET', `/api/wallet/${user.id}`, { token: user.token });
    assert.equal(w.data.coins, 15);
});

test('после истечения сумма освобождается, а новый заказ создаётся заново', async () => {
    const user = await srv.register('renew');
    const first = await srv.request('POST', '/api/payment/create-order', { token: user.token, json: { packageId: 'pkg_15' } });
    await sleep(2300);

    const second = await srv.request('POST', '/api/payment/create-order', { token: user.token, json: { packageId: 'pkg_15' } });
    assert.equal(second.status, 200);
    assert.notEqual(second.data.orderId, first.data.orderId);
    assert.equal(second.data.status, 'PENDING');

    // и новый заказ нормально оплачивается
    const paid = await hook(smsFor(second.data.amount));
    assert.equal(paid.data.success, true);
    const w = await srv.request('GET', `/api/wallet/${user.id}`, { token: user.token });
    assert.equal(w.data.coins, 30);
});
