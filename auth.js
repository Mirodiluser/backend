const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { getUser } = require('./database');

// Секрет для подписи токенов берётся только из окружения.
// Раньше здесь был запасной секрет, зашитый в код, — по нему любой мог подделать токен.
let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
    JWT_SECRET = crypto.randomBytes(48).toString('hex');
    console.warn(
        '⚠️  JWT_SECRET не задан в окружении. Использован случайный секрет: ' +
        'после каждого перезапуска сервера все пользователи будут разлогинены. ' +
        'Задайте JWT_SECRET (длинная случайная строка) в .env / настройках хостинга.'
    );
}

function signToken(userId) {
    return jwt.sign({ id: userId }, JWT_SECRET, { expiresIn: '30d' });
}

// Middleware: требует заголовок "Authorization: Bearer <token>", кладёт пользователя в req.user
function requireAuth(req, res, next) {
    const header = req.headers.authorization || '';
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) {
        return res.status(401).json({ error: 'Avtorizatsiya talab qilinadi' });
    }

    try {
        const payload = jwt.verify(match[1], JWT_SECRET);
        const user = getUser(payload.id);
        if (!user) {
            return res.status(401).json({ error: 'Foydalanuvchi topilmadi, qaytadan kiring' });
        }
        req.user = { id: user.id };
        return next();
    } catch (e) {
        return res.status(401).json({ error: 'Sessiya muddati tugagan, qaytadan kiring' });
    }
}

// Middleware: пользователь может обращаться только к своим данным (/:userId в пути)
function requireSelf(req, res, next) {
    const requestedId = parseInt(req.params.userId, 10);
    if (!requestedId || requestedId !== req.user.id) {
        return res.status(403).json({ error: 'Ruxsat yoʻq' });
    }
    return next();
}

module.exports = { signToken, requireAuth, requireSelf };
