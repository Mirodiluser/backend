const express = require('express');
const crypto = require('crypto');
const { requireAuth } = require('./auth');
const {
    createOrder,
    getOrderForUser,
    creditPendingOrderByAmount,
    PaymentError
} = require('./database');

// ------------------------------------------------------------
// Каталог пакетов. Цена и количество монет определяются ЗДЕСЬ, на сервере.
// Клиент присылает только id пакета. Список должен совпадать с coinPackages на фронтенде.
// ------------------------------------------------------------
const PACKAGES = {
    pkg_15:   { price: 7990,   coins: 15 },
    pkg_50:   { price: 22990,  coins: 55 },    // 50 + 5 бонус
    pkg_100:  { price: 42990,  coins: 115 },   // 100 + 15 бонус
    pkg_250:  { price: 99990,  coins: 290 },   // 250 + 40 бонус
    pkg_500:  { price: 169990, coins: 580 },   // 500 + 80 бонус
    pkg_1200: { price: 309990, coins: 1150 }   // 1000 + 150 бонус
};

// ------------------------------------------------------------
// Разбор суммы из SMS банка.
// Понимает: "8 027 sum", "8,027.00 UZS", "8027 so'm", "8 027,00 сум", "+7990 сум".
// Берётся ПЕРВАЯ сумма в тексте. Если сумма не целая (есть тийины) — считаем, что не распознали.
// ------------------------------------------------------------
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

// ------------------------------------------------------------
// Защита вебхука: общий секрет из окружения (заголовок x-webhook-secret или ?secret=...)
// Если WEBHOOK_SECRET не задан — вебхук закрыт (иначе любой мог бы «оплатить» заказ).
// ------------------------------------------------------------
function safeEqual(a, b) {
    const ha = crypto.createHash('sha256').update(String(a)).digest();
    const hb = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(ha, hb);
}

let warnedNoSecret = false;
function requireWebhookSecret(req, res, next) {
    const expected = process.env.WEBHOOK_SECRET;
    if (!expected) {
        if (!warnedNoSecret) {
            console.error('❌ WEBHOOK_SECRET не задан — вебхук SMS отключён. Задайте его в окружении.');
            warnedNoSecret = true;
        }
        return res.status(503).json({ error: 'Webhook sozlanmagan' });
    }

    const provided = req.headers['x-webhook-secret'] || req.query.secret || '';
    if (!provided || !safeEqual(provided, expected)) {
        return res.status(401).json({ error: 'Ruxsat yoʻq' });
    }
    return next();
}

function createPaymentsRouter() {
    const router = express.Router();

    // 1. Создание заказа на оплату
    router.post('/payment/create-order', requireAuth, (req, res) => {
        try {
            const packageId = req.body && req.body.packageId;
            if (typeof packageId !== 'string' || !Object.prototype.hasOwnProperty.call(PACKAGES, packageId)) {
                return res.status(400).json({ error: 'Notoʻgʻri paket' });
            }

            const pkg = PACKAGES[packageId];
            const order = createOrder({
                userId: req.user.id,
                packageId,
                baseAmount: pkg.price,
                coins: pkg.coins
            });

            console.log(`💳 Buyurtma: ${order.orderId} | user ${req.user.id} | ${order.amount} so'm | ${order.coins} tanga`);
            return res.json({ success: true, ...order, baseAmount: pkg.price });
        } catch (error) {
            if (error instanceof PaymentError) {
                return res.status(429).json({ error: error.message });
            }
            console.error('Create order error:', error);
            return res.status(500).json({ error: 'Buyurtma yaratishda xatolik' });
        }
    });

    // 2. Статус заказа (опрашивается фронтендом). Заказ виден только его владельцу.
    router.get('/payment/check-status/:orderId', requireAuth, (req, res) => {
        try {
            const order = getOrderForUser(req.params.orderId, req.user.id);
            if (!order) {
                return res.status(404).json({ error: 'Buyurtma topilmadi' });
            }
            return res.json({
                status: order.status,
                coins: order.coins,
                amount: order.amount,
                expiresInSec: order.expiresInSec
            });
        } catch (error) {
            console.error('Check status error:', error);
            return res.status(500).json({ error: 'Server xatosi' });
        }
    });

    // 3. Вебхук для SMS с телефона (автоматическое зачисление).
    // Принимает JSON ({text}), form-urlencoded или обычный текст — в зависимости от приложения-пересыльщика.
    router.post(
        '/webhook/sms',
        requireWebhookSecret,
        express.urlencoded({ extended: false, limit: '20kb' }),
        express.text({ type: 'text/plain', limit: '20kb' }),
        (req, res) => {
            try {
                const body = req.body;
                const text = typeof body === 'string'
                    ? body
                    : body && (body.text || body.message || body.body || body.sms);

                if (!text || typeof text !== 'string') {
                    return res.status(400).json({ error: 'SMS matni topilmadi' });
                }

                const amount = parseSmsAmount(text);
                if (!amount) {
                    // Это не SMS о платеже (код подтверждения, реклама и т.п.) — просто игнорируем.
                    // Отвечаем 200, чтобы приложение-пересыльщик не повторяло отправку.
                    return res.json({ success: false, reason: 'amount_not_found' });
                }

                const order = creditPendingOrderByAmount(amount, text);
                if (!order) {
                    console.log(`⚠️ Mos keluvchi faol buyurtma topilmadi (${amount} so'm)`);
                    return res.json({ success: false, reason: 'no_matching_order' });
                }

                console.log(`✅ To'lov tasdiqlandi: ${order.order_id} | user ${order.user_id} | +${order.coins} tanga`);
                return res.json({ success: true, userId: order.user_id, coinsAdded: order.coins });
            } catch (error) {
                console.error('Webhook SMS error:', error);
                return res.status(500).json({ error: 'Server xatosi' });
            }
        }
    );

    return router;
}

module.exports = { createPaymentsRouter, parseSmsAmount, PACKAGES };
