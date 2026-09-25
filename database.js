const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

let db = null;
const DB_PATH = path.join(__dirname, 'users.db');

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
    
    saveDatabase();
    console.log('✅ База данных готова');
}

// Сохранение базы в файл
function saveDatabase() {
    try {
        if (!db) return;
        const data = db.export();
        const buffer = Buffer.from(data);
        fs.writeFileSync(DB_PATH, buffer);
    } catch (e) {
        console.error('Ошибка сохранения БД:', e.message);
    }
}

// Экранирование SQL-строки
function escapeSql(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/'/g, "''");
}

// Поиск пользователя по ID
function getUser(userId) {
    const safeId = parseInt(userId) || 0;
    const result = db.exec(`SELECT * FROM users WHERE id = ${safeId}`);
    
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

// Получить баланс
function getBalance(userId) {
    const user = getUser(userId);
    return user ? user.coins : 0;
}

// Добавить монеты
function addCoins(userId, amount, description = 'Пополнение баланса') {
    const safeId = parseInt(userId) || 0;
    const safeAmount = parseInt(amount) || 0;
    const safeDescription = escapeSql(description);
    
    db.run(`UPDATE users SET coins = coins + ${safeAmount}, total_purchased = total_purchased + ${safeAmount} WHERE id = ${safeId}`);
    db.run(`INSERT INTO transactions (user_id, type, amount, description) VALUES (${safeId}, 'purchase', ${safeAmount}, '${safeDescription}')`);
    saveDatabase();
    
    return getBalance(safeId);
}

// Списать монеты
function spendCoins(userId, amount, description = 'Оплата услуги') {
    const safeId = parseInt(userId) || 0;
    const safeAmount = parseInt(amount) || 0;
    const safeDescription = escapeSql(description);
    
    const user = getUser(safeId);
    if (!user || user.coins < safeAmount) {
        throw new Error('Недостаточно монет');
    }
    
    db.run(`UPDATE users SET coins = coins - ${safeAmount}, total_spent = total_spent + ${safeAmount} WHERE id = ${safeId}`);
    db.run(`INSERT INTO transactions (user_id, type, amount, description) VALUES (${safeId}, 'spend', ${safeAmount}, '${safeDescription}')`);
    saveDatabase();
    
    return getBalance(safeId);
}

// Получить историю транзакций
function getTransactions(userId, limit = 20) {
    const safeId = parseInt(userId) || 0;
    const result = db.exec(`SELECT * FROM transactions WHERE user_id = ${safeId} ORDER BY id DESC LIMIT ${limit}`);
    
    if (result.length === 0) return [];
    
    const columns = result[0].columns;
    return result[0].values.map(row => {
        const obj = {};
        columns.forEach((col, idx) => {
            obj[col] = row[idx];
        });
        return obj;
    });
}

// Получить статистику
function getStats(userId) {
    const user = getUser(userId);
    if (!user) {
        return { coins: 0, totalSpent: 0, totalPurchased: 0, totalTransactions: 0 };
    }
    
    let totalTransactions = 0;
    const txResult = db.exec(`SELECT COUNT(*) as count FROM transactions WHERE user_id = ${userId}`);
    if (txResult.length > 0 && txResult[0].values.length > 0) {
        totalTransactions = txResult[0].values[0][0];
    }
    
    return {
        coins: user.coins,
        totalSpent: user.total_spent,
        totalPurchased: user.total_purchased,
        totalTransactions: totalTransactions
    };
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
    db // Экспортируем объект базы данных для сервера
};