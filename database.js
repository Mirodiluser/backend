const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let db = null;
// Путь к файлу БД можно переопределить (например, на постоянный диск хостинга или для тестов)
const DB_PATH = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(__dirname, 'users.db');

// ------------------------------------------------------------
// Настройки платежей
// ------------------------------------------------------------
// Сколько живёт заказ: за это время сумма зарезервирована за пользователем
// и входящий платёж будет засчитан.
const ORDER_TTL_SEC = parseInt(process.env.ORDER_TTL_SEC, 10) || 30 * 60;
// Сколько неоплаченных заказов может одновременно иметь один пользователь
const MAX_PENDING_PER_USER = 3;
// К цене пакета добавляется случайная надбавка 1..N сум, чтобы у каждого
// активного заказа была своя уникальная сумма (по ней SMS сопоставляется с заказом)
const UNIQUE_SUFFIX_MAX = 99;

class PaymentError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

function nowSec() {
    return Math.floor(Date.now() / 1000);
}

// ------------------------------------------------------------
// Инициализация базы данных
// ------------------------------------------------------------
async function initDatabase() {
    const SQL = await initSqlJs();

    if (fs.existsSync(DB_PATH)) {
        const fileBuffer = fs.readFileSync(DB_PATH);
        db = new SQL.Database(fileBuffer);
    } else {
        db = new SQL.Database();
    }

    db.run(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            identifier TEXT UNIQUE,
            name TEXT DEFAULT '',
            password TEXT DEFAULT '',
            coins INTEGER DEFAULT 15,
            total_spent INTEGER DEFAULT 0,
            total_purchased INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now'))
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            type TEXT NOT NULL,
            amount INTEGER NOT NULL,
            description TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        )
    `);

    // Таблица заказов для автоматических P2P платежей (Click / Payme)
    db.run(`
        CREATE TABLE IF NOT EXISTS orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id TEXT UNIQUE,
            user_id INTEGER,
            package_id TEXT,
            amount INTEGER,
            coins INTEGER,
            status TEXT DEFAULT 'PENDING',
            created_at TEXT DEFAULT (datetime('now'))
        )
    `);

    // Миграция: старая таблица orders не имела этих колонок
    const orderCols = db.exec('PRAGMA table_info(orders)')[0].values.map((row) => row[1]);
    if (!orderCols.includes('expires_at')) db.run('ALTER TABLE orders ADD COLUMN expires_at INTEGER');
    if (!orderCols.includes('paid_at')) db.run('ALTER TABLE orders ADD COLUMN paid_at INTEGER');

    // Старые заказы без срока действия считаем истёкшими
    db.run("UPDATE orders SET status = 'EXPIRED' WHERE status = 'PENDING' AND expires_at IS NULL");

    // Защита на уровне БД: у двух активных заказов не может быть одинаковой суммы
    db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_pending_amount ON orders(amount) WHERE status = 'PENDING'");
    db.run('CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id)');

    // Журнал входящих SMS: нужен, чтобы разобраться, если деньги пришли, а монеты не зачислились
    db.run(`
        CREATE TABLE IF NOT EXISTS sms_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            text TEXT,
            amount INTEGER,
            matched_order_id TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        )
    `);

    saveDatabase();
    console.log('✅ База данных готова');
}

// Сохранение базы в файл.
// ВАЖНО: db.export() в sql.js закрывает и заново открывает базу, поэтому
// вызывать эту функцию внутри открытой транзакции нельзя — транзакция потеряется.
function saveDatabase() {
    try {
        if (!db) return;
        const data = db.export();
        const buffer = Buffer.from(data);
        const tmpPath = `${DB_PATH}.tmp`;
        try {
            // Пишем во временный файл и подменяем, чтобы сбой посреди записи не испортил БД
            fs.writeFileSync(tmpPath, buffer);
            fs.renameSync(tmpPath, DB_PATH);
        } catch (e) {
            fs.writeFileSync(DB_PATH, buffer);
        }
    } catch (e) {
        console.error('Ошибка сохранения БД:', e.message);
    }
}

// ------------------------------------------------------------
// Вспомогательные функции для запросов
// ------------------------------------------------------------
function all(sql, params = []) {
    const stmt = db.prepare(sql);
    try {
        stmt.bind(params);
        const rows = [];
        while (stmt.step()) rows.push(stmt.getAsObject());
        return rows;
    } finally {
        stmt.free();
    }
}

function inTransaction(fn) {
    db.run('BEGIN');
    try {
        const result = fn();
        db.run('COMMIT');
        return result;
    } catch (e) {
        try { db.run('ROLLBACK'); } catch (_) { /* транзакция уже закрыта */ }
        throw e;
    }
}

function toPositiveInt(value) {
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n <= 0) {
        throw new Error('Notoʻgʻri miqdor');
    }
    return n;
}

// Экранирование SQL-строки
function escapeSql(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/'/g, "''");
}

// ------------------------------------------------------------
// Пользователи
// ------------------------------------------------------------

// Поиск пользователя по ID
function getUser(userId) {
    const safeId = parseInt(userId) || 0;
    return all('SELECT * FROM users WHERE id = ?', [safeId])[0] || null;
}

// Поиск пользователя по Email / Номеру
function getUserByIdentifier(identifier) {
    const safeId = escapeSql(identifier.trim().toLowerCase());
    const result = db.exec(`SELECT * FROM users WHERE identifier = '${safeId}'`);

    if (result.length === 0 || result[0].values.length === 0) {
        return null;
    }

    const row = result[0].values[0];
    const columns = result[0].columns;
    const user = {};
    columns.forEach((col, idx) => {
        user[col] = row[idx];
    });
    return user;
}

// Создание пользователя
function createUser(identifier, name, hashedPassword, initialCoins = 15) {
    const safeId = escapeSql(identifier.trim().toLowerCase());
    const safeName = escapeSql(name);
    const safePass = escapeSql(hashedPassword);

    db.run(`
        INSERT INTO users (identifier, name, password, coins, total_purchased)
        VALUES ('${safeId}', '${safeName}', '${safePass}', ${initialCoins}, ${initialCoins})
    `);

    const lastIdResult = db.exec("SELECT last_insert_rowid()");
    const newId = lastIdResult[0].values[0][0];

    db.run(`
        INSERT INTO transactions (user_id, type, amount, description)
        VALUES (${newId}, 'bonus', ${initialCoins}, 'Roʻyxatdan oʻtish bonusi (+15 tanga)')
    `);

    saveDatabase();
    return getUser(newId);
}

// ------------------------------------------------------------
// Кошелёк (монеты)
// ------------------------------------------------------------

// Получить баланс
function getBalance(userId) {
    const user = getUser(userId);
    return user ? user.coins : 0;
}

// Начисление монет без сохранения файла — для использования внутри транзакций
function creditCoinsTx(userId, amount, type, description) {
    db.run(
        'UPDATE users SET coins = coins + ?, total_purchased = total_purchased + ? WHERE id = ?',
        [amount, amount, userId]
    );
    if (db.getRowsModified() !== 1) {
        throw new Error('Foydalanuvchi topilmadi');
    }
    db.run(
        'INSERT INTO transactions (user_id, type, amount, description) VALUES (?, ?, ?, ?)',
        [userId, type, amount, description]
    );
}

// Добавить монеты
function addCoins(userId, amount, description = 'Пополнение баланса') {
    const safeId = parseInt(userId) || 0;
    const safeAmount = toPositiveInt(amount);

    inTransaction(() => creditCoinsTx(safeId, safeAmount, 'purchase', description));
    saveDatabase();

    return getBalance(safeId);
}

// Списать монеты (проверка баланса и списание — одной атомарной операцией)
function spendCoins(userId, amount, description = 'Оплата услуги') {
    const safeId = parseInt(userId) || 0;
    const safeAmount = toPositiveInt(amount);

    inTransaction(() => {
        db.run(
            'UPDATE users SET coins = coins - ?, total_spent = total_spent + ? WHERE id = ? AND coins >= ?',
            [safeAmount, safeAmount, safeId, safeAmount]
        );
        if (db.getRowsModified() !== 1) {
            throw new Error('Недостаточно монет');
        }
        db.run(
            'INSERT INTO transactions (user_id, type, amount, description) VALUES (?, ?, ?, ?)',
            [safeId, 'spend', safeAmount, description]
        );
    });
    saveDatabase();

    return getBalance(safeId);
}

// Вернуть ранее списанные монеты (не считается покупкой)
function refundCoins(userId, amount, description = 'Возврат') {
    const safeId = parseInt(userId) || 0;
    const safeAmount = toPositiveInt(amount);

    inTransaction(() => {
        db.run(
            'UPDATE users SET coins = coins + ?, total_spent = MAX(0, total_spent - ?) WHERE id = ?',
            [safeAmount, safeAmount, safeId]
        );
        if (db.getRowsModified() !== 1) {
            throw new Error('Foydalanuvchi topilmadi');
        }
        db.run(
            'INSERT INTO transactions (user_id, type, amount, description) VALUES (?, ?, ?, ?)',
            [safeId, 'refund', safeAmount, description]
        );
    });
    saveDatabase();

    return getBalance(safeId);
}

// Получить историю транзакций
function getTransactions(userId, limit = 20) {
    const safeId = parseInt(userId) || 0;
    const safeLimit = Math.min(Math.max(parseInt(limit) || 20, 1), 100);
    return all('SELECT * FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT ?', [safeId, safeLimit]);
}

// Получить статистику
function getStats(userId) {
    const user = getUser(userId);
    if (!user) {
        return { coins: 0, totalSpent: 0, totalPurchased: 0, totalTransactions: 0 };
    }

    const countRow = all('SELECT COUNT(*) AS count FROM transactions WHERE user_id = ?', [user.id])[0];

    return {
        coins: user.coins,
        totalSpent: user.total_spent,
        totalPurchased: user.total_purchased,
        totalTransactions: countRow ? countRow.count : 0
    };
}

// ------------------------------------------------------------
// Заказы на оплату
// ------------------------------------------------------------

// Перевести просроченные заказы в EXPIRED (освобождает их суммы)
function expireStaleOrders() {
    db.run(
        "UPDATE orders SET status = 'EXPIRED' WHERE status = 'PENDING' AND (expires_at IS NULL OR expires_at <= ?)",
        [nowSec()]
    );
}

function publicOrder(row) {
    if (!row) return null;
    return {
        orderId: row.order_id,
        packageId: row.package_id,
        amount: row.amount,
        coins: row.coins,
        status: row.status,
        expiresAt: row.expires_at,
        expiresInSec: Math.max(0, (row.expires_at || 0) - nowSec())
    };
}

// Создать заказ. Цена и количество монет определяются сервером (из каталога пакетов),
// клиенту доверять нельзя. Если у пользователя уже есть активный заказ на этот пакет —
// возвращается он же (повторное нажатие кнопки не плодит заказы).
function createOrder({ userId, packageId, baseAmount, coins }) {
    const safeUserId = parseInt(userId) || 0;
    const base = toPositiveInt(baseAmount);
    const safeCoins = toPositiveInt(coins);

    const order = inTransaction(() => {
        expireStaleOrders();

        const existing = all(
            "SELECT * FROM orders WHERE status = 'PENDING' AND user_id = ? AND package_id = ? ORDER BY id DESC LIMIT 1",
            [safeUserId, packageId]
        )[0];
        if (existing) return existing;

        const pendingCount = all(
            "SELECT COUNT(*) AS count FROM orders WHERE status = 'PENDING' AND user_id = ?",
            [safeUserId]
        )[0].count;
        if (pendingCount >= MAX_PENDING_PER_USER) {
            throw new PaymentError('TOO_MANY_PENDING', 'Sizda juda koʻp tugallanmagan buyurtma bor. Birozdan soʻng urinib koʻring.');
        }

        const taken = new Set(
            all(
                "SELECT amount FROM orders WHERE status = 'PENDING' AND amount BETWEEN ? AND ?",
                [base + 1, base + UNIQUE_SUFFIX_MAX]
            ).map((row) => row.amount)
        );
        const freeAmounts = [];
        for (let suffix = 1; suffix <= UNIQUE_SUFFIX_MAX; suffix++) {
            if (!taken.has(base + suffix)) freeAmounts.push(base + suffix);
        }
        if (freeAmounts.length === 0) {
            throw new PaymentError('NO_FREE_AMOUNT', 'Hozir band, birozdan soʻng qayta urinib koʻring.');
        }

        const amount = freeAmounts[crypto.randomInt(0, freeAmounts.length)];
        const orderId = `ord_${crypto.randomBytes(12).toString('hex')}`;
        const createdAt = nowSec();

        db.run(
            `INSERT INTO orders (order_id, user_id, package_id, amount, coins, status, expires_at)
             VALUES (?, ?, ?, ?, ?, 'PENDING', ?)`,
            [orderId, safeUserId, packageId, amount, safeCoins, createdAt + ORDER_TTL_SEC]
        );
        return all('SELECT * FROM orders WHERE order_id = ?', [orderId])[0];
    });

    saveDatabase();
    return publicOrder(order);
}

// Получить заказ (только владельцу)
function getOrderForUser(orderId, userId) {
    expireStaleOrders();
    const row = all('SELECT * FROM orders WHERE order_id = ? AND user_id = ?', [String(orderId), parseInt(userId) || 0])[0];
    return publicOrder(row);
}

// Зачислить оплату по входящему SMS: ищем активный заказ с ТОЧНО такой суммой.
// Всё выполняется одной транзакцией: либо заказ помечен оплаченным И монеты начислены, либо ничего.
function creditPendingOrderByAmount(amount, smsText) {
    const credited = inTransaction(() => {
        expireStaleOrders();

        const order = all(
            "SELECT * FROM orders WHERE status = 'PENDING' AND amount = ? AND expires_at > ? ORDER BY id ASC LIMIT 1",
            [amount, nowSec()]
        )[0];

        db.run(
            'INSERT INTO sms_log (text, amount, matched_order_id) VALUES (?, ?, ?)',
            [String(smsText || '').slice(0, 500), amount, order ? order.order_id : null]
        );
        db.run('DELETE FROM sms_log WHERE id <= (SELECT COALESCE(MAX(id), 0) FROM sms_log) - 1000');

        if (!order) return null;

        // Условие status = 'PENDING' гарантирует, что один заказ не будет оплачен дважды
        db.run(
            "UPDATE orders SET status = 'PAID', paid_at = ? WHERE id = ? AND status = 'PENDING'",
            [nowSec(), order.id]
        );
        if (db.getRowsModified() !== 1) return null;

        creditCoinsTx(order.user_id, order.coins, 'purchase', `To'lov tasdiqlandi: ${order.amount} so'm (${order.order_id})`);
        return order;
    });

    saveDatabase();
    return credited;
}

module.exports = {
    initDatabase,
    getUser,
    getUserByIdentifier,
    createUser,
    getBalance,
    addCoins,
    spendCoins,
    refundCoins,
    getTransactions,
    getStats,
    createOrder,
    getOrderForUser,
    creditPendingOrderByAmount,
    PaymentError,
    ORDER_TTL_SEC
};
