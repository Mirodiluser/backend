const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

let db = null;
// Путь к файлу БД можно переопределить (постоянный диск на хостинге, тесты)
const DB_PATH = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(__dirname, 'users.db');

// Инициализация базы данных
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

    // Таблица для автоматических P2P платежей (Click / Payme)
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

    // Журнал входящих SMS с распознанной суммой: помогает разобраться, если деньги пришли, а монет нет
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
// ВАЖНО: db.export() в sql.js закрывает и заново открывает базу, поэтому вызывать
// эту функцию внутри открытой транзакции нельзя: транзакция потеряется.
function saveDatabase() {
    try {
        if (!db) return;
        const data = db.export();
        const buffer = Buffer.from(data);
        // Пишем во временный файл и подменяем, чтобы сбой посреди записи не испортил БД
        const tmpPath = `${DB_PATH}.tmp`;
        try {
            fs.writeFileSync(tmpPath, buffer);
            fs.renameSync(tmpPath, DB_PATH);
        } catch (e) {
            fs.writeFileSync(DB_PATH, buffer);
        }
    } catch (e) {
        console.error('Ошибка сохранения БД:', e.message);
    }
}

// Выполнение запроса с параметрами (без подстановки значений в строку SQL)
function run(sql, params = []) {
    db.run(sql, params);
}

// Выборка строк в виде массива объектов
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

function get(sql, params = []) {
    return all(sql, params)[0] || null;
}

// Положительное целое число или ошибка
function toPositiveInt(value) {
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) {
        throw new Error('Notoʻgʻri miqdor');
    }
    return n;
}

// Поиск пользователя по ID
function getUser(userId) {
    return get('SELECT * FROM users WHERE id = ?', [parseInt(userId) || 0]);
}

// Поиск пользователя по Email / Номеру
function getUserByIdentifier(identifier) {
    return get('SELECT * FROM users WHERE identifier = ?', [String(identifier).trim().toLowerCase()]);
}

// Создание пользователя
function createUser(identifier, name, hashedPassword, initialCoins = 15) {
    run(
        'INSERT INTO users (identifier, name, password, coins, total_purchased) VALUES (?, ?, ?, ?, ?)',
        [String(identifier).trim().toLowerCase(), name, hashedPassword, initialCoins, initialCoins]
    );

    const newId = db.exec('SELECT last_insert_rowid()')[0].values[0][0];

    run(
        "INSERT INTO transactions (user_id, type, amount, description) VALUES (?, 'bonus', ?, ?)",
        [newId, initialCoins, 'Roʻyxatdan oʻtish bonusi (+15 tanga)']
    );

    saveDatabase();
    return getUser(newId);
}

// Получить баланс
function getBalance(userId) {
    const user = getUser(userId);
    return user ? user.coins : 0;
}

// Добавить монеты
function addCoins(userId, amount, description = 'Пополнение баланса') {
    const safeId = parseInt(userId) || 0;
    const safeAmount = toPositiveInt(amount);

    run('UPDATE users SET coins = coins + ?, total_purchased = total_purchased + ? WHERE id = ?', [safeAmount, safeAmount, safeId]);
    run("INSERT INTO transactions (user_id, type, amount, description) VALUES (?, 'purchase', ?, ?)", [safeId, safeAmount, description]);
    saveDatabase();

    return getBalance(safeId);
}

// Списать монеты
function spendCoins(userId, amount, description = 'Оплата услуги') {
    const safeId = parseInt(userId) || 0;
    const safeAmount = toPositiveInt(amount);

    const user = getUser(safeId);
    if (!user || user.coins < safeAmount) {
        throw new Error('Недостаточно монет');
    }

    run('UPDATE users SET coins = coins - ?, total_spent = total_spent + ? WHERE id = ?', [safeAmount, safeAmount, safeId]);
    run("INSERT INTO transactions (user_id, type, amount, description) VALUES (?, 'spend', ?, ?)", [safeId, safeAmount, description]);
    saveDatabase();

    return getBalance(safeId);
}

// Получить историю транзакций
function getTransactions(userId, limit = 20) {
    return all('SELECT * FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT ?', [parseInt(userId) || 0, parseInt(limit) || 20]);
}

// Получить статистику
function getStats(userId) {
    const user = getUser(userId);
    if (!user) {
        return { coins: 0, totalSpent: 0, totalPurchased: 0, totalTransactions: 0 };
    }

    const row = get('SELECT COUNT(*) AS count FROM transactions WHERE user_id = ?', [user.id]);

    return {
        coins: user.coins,
        totalSpent: user.total_spent,
        totalPurchased: user.total_purchased,
        totalTransactions: row ? row.count : 0
    };
}

// ============================================================
// Заказы (P2P платежи)
// ============================================================
function createOrder(orderId, userId, packageId, amount, coins) {
    run(
        "INSERT INTO orders (order_id, user_id, package_id, amount, coins, status, created_at) VALUES (?, ?, ?, ?, ?, 'PENDING', datetime('now'))",
        [orderId, userId, packageId, amount, coins]
    );
    saveDatabase();
}

function getOrder(orderId) {
    return get('SELECT * FROM orders WHERE order_id = ?', [String(orderId)]);
}

// Заказ с возрастом в секундах (по нему считается срок действия и статус EXPIRED)
function getOrderWithAge(orderId) {
    return get(
        "SELECT *, CAST(strftime('%s','now') AS INTEGER) - CAST(strftime('%s', created_at) AS INTEGER) AS age_sec FROM orders WHERE order_id = ?",
        [String(orderId)]
    );
}

// Ожидающие заказы на сумму в диапазоне [min, max] за последние N секунд
function findPendingOrders(minAmount, maxAmount, seconds) {
    return all(
        "SELECT * FROM orders WHERE amount BETWEEN ? AND ? AND status = 'PENDING' AND datetime(created_at) >= datetime('now', ?) ORDER BY id DESC",
        [minAmount, maxAmount, `-${parseInt(seconds)} seconds`]
    );
}

// Оплата заказа: смена статуса, начисление монет и запись в историю одной транзакцией.
// Либо всё выполнено, либо ничего (иначе возможен заказ «оплачен», а монет нет).
// Условие status = 'PENDING' не даёт зачесть один заказ дважды. Возвращает true, если заказ оплачен сейчас.
function payOrder(id) {
    let paid = false;
    db.run('BEGIN');
    try {
        const order = get('SELECT * FROM orders WHERE id = ?', [id]);
        if (order) {
            db.run("UPDATE orders SET status = 'PAID' WHERE id = ? AND status = 'PENDING'", [id]);
            if (db.getRowsModified() === 1) {
                db.run(
                    'UPDATE users SET coins = coins + ?, total_purchased = total_purchased + ? WHERE id = ?',
                    [order.coins, order.coins, order.user_id]
                );
                if (db.getRowsModified() !== 1) throw new Error('Foydalanuvchi topilmadi');
                db.run(
                    "INSERT INTO transactions (user_id, type, amount, description) VALUES (?, 'purchase', ?, ?)",
                    [order.user_id, order.coins, `To'lov tasdiqlandi: ${order.amount} so'm`]
                );
                paid = true;
            }
        }
        db.run('COMMIT');
    } catch (e) {
        try { db.run('ROLLBACK'); } catch (_) { /* транзакция уже закрыта */ }
        throw e;
    }
    saveDatabase();
    return paid;
}

// Запись входящего SMS в журнал (хранятся последние 1000)
function logSms(text, amount, matchedOrderId) {
    run('INSERT INTO sms_log (text, amount, matched_order_id) VALUES (?, ?, ?)', [String(text || '').slice(0, 500), amount, matchedOrderId || null]);
    run('DELETE FROM sms_log WHERE id <= (SELECT COALESCE(MAX(id), 0) FROM sms_log) - 1000');
    saveDatabase();
}

module.exports = {
    initDatabase,
    getUser,
    getUserByIdentifier,
    createUser,
    getBalance,
    addCoins,
    spendCoins,
    getTransactions,
    getStats,
    createOrder,
    getOrder,
    getOrderWithAge,
    findPendingOrders,
    payOrder,
    logSms
};