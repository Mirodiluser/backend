// Отдельный файл: сервер запускается с очень коротким сроком заказа (ORDER_TTL_SECONDS=2)
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, sleep } = require('./helpers');

let srv;
test.before(async () => { srv = await startServer({ ORDER_TTL_SECONDS: '2' }); });
test.after(async () => { if (srv) await srv.stop(); });

const hook = (text) =>
    srv.request('POST', '/api/webhook/sms', { headers: { 'x-webhook-secret': 'test-hook-secret' }, json: { text } });

test('просроченный заказ получает статус EXPIRED и платёж по нему не засчитывается', async () => {
    const user = await srv.register('late');
    const order = await srv.request('POST', '/api/payment/create-order', { token: user.token, json: { packageId: 'pkg_15' } });
    assert.equal(order.status, 200);
    assert.equal(order.data.expiresInSec, 2);

    await sleep(3200);

    const status = await srv.request('GET', `/api/payment/check-status/${order.data.orderId}`, { token: user.token });
    assert.equal(status.data.status, 'EXPIRED');
    assert.equal(status.data.expiresInSec, 0);

    assert.equal((await hook(`+${order.data.amount} sum`)).status, 404);
    const w = await srv.request('GET', '/api/wallet', { token: user.token });
    assert.equal(w.data.coins, 15);
});

test('после истечения сумма освобождается, новый заказ оплачивается нормально', async () => {
    const user = await srv.register('renew');
    const first = await srv.request('POST', '/api/payment/create-order', { token: user.token, json: { packageId: 'pkg_15' } });
    await sleep(3200);

    const second = await srv.request('POST', '/api/payment/create-order', { token: user.token, json: { packageId: 'pkg_15' } });
    assert.notEqual(second.data.orderId, first.data.orderId);
    assert.equal((await hook(`+${second.data.amount} sum`)).status, 200);
    const w = await srv.request('GET', '/api/wallet', { token: user.token });
    assert.equal(w.data.coins, 30);
});
