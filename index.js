if (typeof global.DOMMatrix === 'undefined') {
    global.DOMMatrix = require('dommatrix');
}

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const mammoth = require('mammoth');
const pdfParse = require('pdf-parse');
const WordExtractor = require('word-extractor');
const extractor = new WordExtractor();
const sharp = require('sharp');
const { PDFDocument } = require('pdf-lib');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { exec, execSync } = require('child_process');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'tahrir_ai_jwt_secret_key_2026';

const { 
    initDatabase, 
    getUser, 
    getUserByIdentifier, 
    createUser, 
    getBalance, 
    addCoins, 
    spendCoins, 
    getTransactions, 
    getStats,
    db // Импортируем объект БД для работы с заказами
} = require('./database');

const { fixGrammar, transliterateWithAI } = require('./grammar');
const { processDocxWithProgress } = require('./docxProcessor');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ============================================================
// Поиск LibreOffice (soffice.exe)
// ============================================================
function findLibreOffice() {
    const possiblePaths = [
        'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
        'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
        path.join(os.homedir(), 'Desktop', 'LibreOffice', 'program', 'soffice.exe'),
        path.join(os.homedir(), 'Desktop', 'LibreOfficePortable', 'App', 'libreoffice', 'program', 'soffice.exe'),
        path.join(os.homedir(), 'OneDrive', 'Desktop', 'LibreOffice', 'program', 'soffice.exe'),
        path.join(os.homedir(), 'OneDrive', 'Рабочий стол', 'LibreOffice', 'program', 'soffice.exe'),
        'D:\\LibreOffice\\program\\soffice.exe',
        'E:\\LibreOffice\\program\\soffice.exe',
    ];
    
    for (const p of possiblePaths) {
        if (fs.existsSync(p)) {
            console.log(`✅ LibreOffice topildi: ${p}`);
            return p;
        }
    }
    
    try {
        const result = execSync('where soffice', { encoding: 'utf-8' });
        const paths = result.trim().split('\n');
        if (paths.length > 0 && paths[0].trim()) {
            console.log(`✅ LibreOffice topildi (PATH): ${paths[0].trim()}`);
            return paths[0].trim();
        }
    } catch (e) {}
    
    console.error('❌ LibreOffice (soffice.exe) topilmadi');
    return null;
}

// ============================================================
// Вспомогательный точный подсчет страниц для любых документов
// ============================================================
async function getDocumentPageCount(fileBuffer, fileName) {
    const ext = fileName.toLowerCase();

    if (ext.endsWith('.pdf')) {
        try {
            const pdfData = await pdfParse(fileBuffer);
            return Math.max(1, pdfData.numpages || 1);
        } catch (e) {
            console.error('PDF page count error:', e);
            return 1;
        }
    }

    if (ext.endsWith('.docx')) {
        try {
            const result = await mammoth.extractRawText({ buffer: fileBuffer });
            const rawText = result.value || '';
            const words = rawText.trim().split(/\s+/).filter(Boolean).length;
            if (words > 0) {
                return Math.max(1, Math.ceil(words / 250));
            }
        } catch (e) {
            console.error('Mammoth DOCX page count error:', e);
        }
    }

    if (ext.endsWith('.doc')) {
        try {
            const extracted = await extractor.extract(fileBuffer);
            const text = extracted.getBody() || '';
            const words = text.trim().split(/\s+/).filter(Boolean).length;
            if (words > 0) {
                return Math.max(1, Math.ceil(words / 250));
            }
        } catch (e) {
            console.error('DOC page count error:', e);
        }
    }

    if (ext.endsWith('.txt')) {
        const text = fileBuffer.toString('utf-8');
        return Math.max(1, Math.ceil(text.length / 1800));
    }

    return 1;
}

// ============================================================
// API: Авторизация и Регистрация пользователей
// ============================================================

app.post('/api/auth/register', async (req, res) => {
    try {
        const { identifier, password, name } = req.body;
        if (!identifier || !password) {
            return res.status(400).json({ error: 'Email/telefon va parol kiritilishi shart' });
        }

        const cleanId = identifier.trim().toLowerCase();
        const existing = getUserByIdentifier(cleanId);
        if (existing) {
            return res.status(400).json({ error: 'Bu email yoki telefon allaqachon roʻyxatdan oʻtgan' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const displayName = name ? name.trim() : cleanId.split('@')[0];

        const newUser = createUser(cleanId, displayName, hashedPassword, 15);
        const token = jwt.sign({ id: newUser.id }, JWT_SECRET, { expiresIn: '30d' });

        return res.json({
            success: true,
            token,
            user: {
                id: newUser.id,
                identifier: newUser.identifier,
                name: newUser.name,
                coins: newUser.coins
            }
        });
    } catch (e) {
        console.error('Register server error:', e);
        return res.status(500).json({ error: 'Serverda roʻyxatdan oʻtishda xatolik yuz berdi' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { identifier, password } = req.body;
        if (!identifier || !password) {
            return res.status(400).json({ error: 'Email/telefon va parol kiritilishi shart' });
        }

        const cleanId = identifier.trim().toLowerCase();
        const user = getUserByIdentifier(cleanId);
        if (!user) {
            return res.status(400).json({ error: 'Foydalanuvchi topilmadi' });
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(400).json({ error: 'Notoʻgʻri parol' });
        }

        const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '30d' });

        return res.json({
            success: true,
            token,
            user: {
                id: user.id,
                identifier: user.identifier,
                name: user.name,
                coins: user.coins
            }
        });
    } catch (e) {
        console.error('Login server error:', e);
        return res.status(500).json({ error: 'Serverda tizimga kirishda xatolik yuz berdi' });
    }
});

app.get('/api/auth/me/:userId', (req, res) => {
    try {
        const userId = parseInt(req.params.userId);
        if (!userId) return res.status(400).json({ error: 'ID kiritilmadi' });

        const user = getUser(userId);
        if (!user) {
            return res.status(404).json({ error: 'Foydalanuvchi topilmadi' });
        }
        return res.json({
            id: user.id,
            identifier: user.identifier,
            name: user.name,
            coins: user.coins
        });
    } catch (e) {
        return res.status(500).json({ error: 'Server xatosi' });
    }
});

// ============================================================
// API: Платежи (Создание заказа, Статус, Вебхук SMS)
// ============================================================

// Yordamchi funksiya: sql.js natijasini obyektlar massiviga o'tkazish
function queryToObjects(sqlQuery) {
    const result = db.exec(sqlQuery);
    if (result.length === 0) return [];
    const columns = result[0].columns;
    return result[0].values.map(row => {
        const obj = {};
        columns.forEach((col, idx) => { obj[col] = row[idx]; });
        return obj;
    });
}

// 1. Создание заказа на оплату
app.post('/api/payment/create-order', (req, res) => {
    try {
        const { orderId, userId, packageId, amount, coins } = req.body;
        if (!orderId || !userId || !amount || !coins) {
            return res.status(400).json({ error: 'Maʼlumotlar yetarli emas' });
        }

        const pkgId = packageId || 'custom';
        db.run(`
            INSERT INTO orders (order_id, user_id, package_id, amount, coins, status, created_at)
            VALUES ('${orderId}', ${userId}, '${pkgId}', ${amount},${coins}, 'PENDING', datetime('now'))
        `);

        console.log(`💳 Yangi buyurtma yaratildi: ${orderId} | Summa: ${amount} so'm \vert{} Tanga:${coins}`);
        return res.json({ success: true, orderId });
    } catch (error) {
        console.error('Create order error:', error);
        return res.status(500).json({ error: 'Buyurtma yaratishda xatolik' });
    }
});

// 2. Проверка статуса заказа (для фронтенда в реальном времени)
app.get('/api/payment/check-status/:orderId', (req, res) => {
    try {
        const { orderId } = req.params;
        const orders = queryToObjects(`SELECT * FROM orders WHERE order_id = '${orderId}' LIMIT 1`);

        if (orders.length === 0) {
            return res.json({ status: 'PENDING' }); 
        }

        return res.json({ status: orders[0].status });
    } catch (error) {
        return res.status(500).json({ error: 'Server xatosi' });
    }
});

// 3. Вебхук для приема SMS от телефона (Автоматическое зачисление + Диапазон + Умный поиск)
app.post('/api/webhook/sms', (req, res) => {
    try {
        const { text } = req.body;
        if (!text) return res.status(400).json({ error: 'SMS matni topilmadi' });

        console.log(`📩 Kelgan SMS: "${text}"`);

        const cleanText = text.replace(/[\s,]/g, '');
        const match = cleanText.match(/(\d+)(sum|сум)/i);

        if (!match) {
            return res.status(400).json({ error: 'SMS dan summani aniqlab boʻlmadi' });
        }

        const incomingAmount = parseInt(match[1], 10);
        console.log(`💰 Aniqlangan summa: ${incomingAmount} so'm`);

        // Шаг 1: Ищем точное совпадение по сумме в активных заказах за последние 15 минут
        let orders = queryToObjects(`
            SELECT * FROM orders 
            WHERE amount = ${incomingAmount} AND status = 'PENDING' 
            AND datetime(created_at) >= datetime('now', '-15 minutes')
            ORDER BY id DESC LIMIT 1
        `);

        // Шаг 2: Если точного совпадения нет, включаем поиск по диапазону (+/- 100 сум)
        if (orders.length === 0) {
            const minAmount = incomingAmount - 100;
            const maxAmount = incomingAmount + 100;
            orders = queryToObjects(`
                SELECT * FROM orders 
                WHERE amount BETWEEN ${minAmount} AND${maxAmount} AND status = 'PENDING' 
                AND datetime(created_at) >= datetime('now', '-10 minutes')
                ORDER BY id DESC LIMIT 1
            `);
        }

        if (orders.length === 0) {
            console.log(`⚠️ Mos keluvchi faol buyurtma topilmadi (${incomingAmount} so'm)`);
            return res.status(404).json({ error: 'Mos buyurtma topilmadi' });
        }

        const order = orders[0];

        // Подтверждаем заказ и начисляем монеты
        db.run(`UPDATE orders SET status = 'PAID' WHERE id = ${order.id}`);
        addCoins(order.user_id, order.coins, `To'lov tasdiqlandi: ${order.amount} so'm`);

        console.log(`✅ To'lov muvaffaqiyatli bajarildi! Foydalanuvchi ID: ${order.user_id} \vert{} +${order.coins} tanga`);
        return res.json({ success: true, userId: order.user_id, coinsAdded: order.coins });
    } catch (error) {
        console.error('Webhook SMS error:', error);
        return res.status(500).json({ error: 'Server xatosi' });
    }
});

// ============================================================
// API: Конвертация файлов (Fayl Konverter)
// ============================================================
app.post('/api/convert-file', upload.array('files', 10), async (req, res) => {
    try {
        const files = req.files;
        const targetFormat = (req.body.targetFormat || 'pdf').toLowerCase();

        if (!files || files.length === 0) {
            return res.status(400).json({ error: 'Fayl yuklanmadi' });
        }

        const firstFile = files[0];
        const ext = firstFile.originalname.toLowerCase();

        if (targetFormat === 'pdf' && /\.(docx|doc)$/i.test(ext)) {
            const libreOfficePath = findLibreOffice();
            if (!libreOfficePath) return res.status(500).json({ error: 'LibreOffice topilmadi' });

            const tempDir = path.join(os.tmpdir(), `convert_${Date.now()}_${Math.random().toString(36).slice(2)}`);
            fs.mkdirSync(tempDir, { recursive: true });

            const inputPath = path.join(tempDir, firstFile.originalname);
            fs.writeFileSync(inputPath, firstFile.buffer);

            try {
                const command = `"${libreOfficePath}" --headless --convert-to pdf --outdir "${tempDir}" "${inputPath}"`;
                await new Promise((resolve, reject) => {
                    exec(command, { timeout: 120000 }, (error) => {
                        if (error) reject(new Error(`LibreOffice xatosi: ${error.message}`));
                        else resolve();
                    });
                });

                const baseName = path.basename(firstFile.originalname, path.extname(firstFile.originalname));
                const pdfPath = path.join(tempDir, `${baseName}.pdf`);

                if (!fs.existsSync(pdfPath)) {
                    const filesInDir = fs.readdirSync(tempDir);
                    const pdfFile = filesInDir.find(f => f.toLowerCase().endsWith('.pdf'));
                    if (!pdfFile) throw new Error('PDF yaratilmadi');
                    
                    const pdfBuffer = fs.readFileSync(path.join(tempDir, pdfFile));
                    setTimeout(() => { try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch(e) {} }, 3000);
                    
                    res.setHeader('Content-Type', 'application/pdf');
                    res.setHeader('Content-Disposition', `attachment; filename="${pdfFile}"`);
                    return res.send(pdfBuffer);
                }

                const pdfBuffer = fs.readFileSync(pdfPath);
                setTimeout(() => { try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch(e) {} }, 3000);

                res.setHeader('Content-Type', 'application/pdf');
                res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(baseName)}.pdf"`);
                return res.send(pdfBuffer);
            } catch (err) {
                setTimeout(() => { try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch(e) {} }, 5000);
                return res.status(500).json({ error: 'PDF ga o\'girishda xatolik' });
            }
        }

        if (targetFormat === 'docx' && ext.endsWith('.pdf')) {
            const libreOfficePath = findLibreOffice();
            if (!libreOfficePath) return res.status(500).json({ error: 'LibreOffice topilmadi' });

            const tempDir = path.join(os.tmpdir(), `convert_${Date.now()}_${Math.random().toString(36).slice(2)}`);
            fs.mkdirSync(tempDir, { recursive: true });

            const inputPath = path.join(tempDir, firstFile.originalname);
            fs.writeFileSync(inputPath, firstFile.buffer);

            try {
                const command = `"${libreOfficePath}" --headless --infilter="writer_pdf_import" --convert-to docx --outdir "${tempDir}" "${inputPath}"`;
                await new Promise((resolve, reject) => {
                    exec(command, { timeout: 180000 }, (error) => {
                        if (error) reject(new Error(`LibreOffice xatosi: ${error.message}`));
                        else resolve();
                    });
                });

                const baseName = path.basename(firstFile.originalname, '.pdf');
                const docxPath = path.join(tempDir, `${baseName}.docx`);

                if (!fs.existsSync(docxPath)) {
                    const filesInDir = fs.readdirSync(tempDir);
                    const docxFile = filesInDir.find(f => f.toLowerCase().endsWith('.docx'));
                    if (!docxFile) throw new Error('DOCX yaratilmadi');
                    
                    const docxBuffer = fs.readFileSync(path.join(tempDir, docxFile));
                    setTimeout(() => { try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch(e) {} }, 3000);
                    
                    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
                    res.setHeader('Content-Disposition', `attachment; filename="${docxFile}"`);
                    return res.send(docxBuffer);
                }

                const docxBuffer = fs.readFileSync(docxPath);
                setTimeout(() => { try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch(e) {} }, 3000);

                res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
                res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(baseName)}.docx"`);
                return res.send(docxBuffer);
            } catch (err) {
                setTimeout(() => { try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch(e) {} }, 5000);
                return res.status(500).json({ error: 'PDF ni DOCX ga o\'girishda xatolik' });
            }
        }

        if (targetFormat === 'txt' && ext.endsWith('.pdf')) {
            try {
                const pdfData = await pdfParse(firstFile.buffer);
                const baseName = path.basename(firstFile.originalname, '.pdf');
                res.setHeader('Content-Type', 'text/plain; charset=utf-8');
                res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(baseName)}.txt"`);
                return res.send(Buffer.from(pdfData.text, 'utf-8'));
            } catch (err) {
                return res.status(500).json({ error: 'PDF ni TXT ga o\'girishda xatolik' });
            }
        }

        if (targetFormat === 'txt' && /\.(docx|doc)$/i.test(ext)) {
            try {
                let text;
                if (ext.endsWith('.docx')) {
                    const result = await mammoth.extractRawText({ buffer: firstFile.buffer });
                    text = result.value || '';
                } else {
                    const extracted = await extractor.extract(firstFile.buffer);
                    text = extracted.getBody() || '';
                }
                const baseName = path.basename(firstFile.originalname, path.extname(firstFile.originalname));
                res.setHeader('Content-Type', 'text/plain; charset=utf-8');
                res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(baseName)}.txt"`);
                return res.send(Buffer.from(text, 'utf-8'));
            } catch (err) {
                return res.status(500).json({ error: 'Faylni TXT ga o\'girishda xatolik' });
            }
        }

        if (targetFormat === 'pdf') {
            const pdfDoc = await PDFDocument.create();
            for (const file of files) {
                const fileExt = file.originalname.toLowerCase();
                if (/\.(jpg|jpeg|png|webp)$/i.test(fileExt)) {
                    const pngBuffer = await sharp(file.buffer).toFormat('png').toBuffer();
                    const image = await pdfDoc.embedPng(pngBuffer);
                    const page = pdfDoc.addPage([image.width, image.height]);
                    page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
                } else if (fileExt.endsWith('.txt')) {
                    const text = file.buffer.toString('utf-8');
                    const page = pdfDoc.addPage([595.28, 841.89]);
                    page.drawText(text.slice(0, 2000), { x: 50, y: 800, size: 12 });
                }
            }
            if (pdfDoc.getPageCount() === 0) {
                return res.status(400).json({ error: 'Bu formatni PDF ga o\'girib bo\'lmaydi' });
            }
            const pdfBytes = await pdfDoc.save();
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="converted_${Date.now()}.pdf"`);
            return res.send(Buffer.from(pdfBytes));
        }

        return res.status(400).json({ error: 'Bu konvertatsiya qo\'llab-quvvatlanmaydi' });
    } catch (error) {
        console.error('Conversion error:', error);
        return res.status(500).json({ error: 'Faylni o\'girishda xatolik yuz berdi' });
    }
});

// ============================================================
// API: Кошелек и Баланс
// ============================================================
app.get('/api/wallet/:userId', (req, res) => {
    try {
        const userId = parseInt(req.params.userId) || 1;
        const stats = getStats(userId);
        const transactions = getTransactions(userId, 10);
        res.json({ ...stats, transactions });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/wallet/add-coins', (req, res) => {
    try {
        const { userId, amount, package: pkg } = req.body;
        const uid = parseInt(userId) || 1;
        const newBalance = addCoins(uid, amount, `Пакет: ${pkg} монет`);
        res.json({ success: true, coins: newBalance, message: `✅ ${amount} tanga qo'shildi!` });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/wallet/spend-coins', (req, res) => {
    try {
        const { userId, amount, description } = req.body;
        const uid = parseInt(userId) || 1;
        const newBalance = spendCoins(uid, amount, description);
        res.json({ success: true, coins: newBalance });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// ============================================================
// API: Подсчёт страниц файла
// ============================================================
app.post('/api/count-pages', upload.single('document'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Fayl yuklanmadi' });
        const pageCount = await getDocumentPageCount(req.file.buffer, req.file.originalname);
        return res.json({ pages: pageCount, requiredCoins: pageCount });
    } catch (err) {
        return res.json({ pages: 1, requiredCoins: 1 });
    }
});

// ============================================================
// Транслитерация и Грамматика
// ============================================================
function transliterateToLatin(text) {
    if (!text) return '';
    let result = text;
    const vowels = 'АЕЁИОУЎЭЮЯаеёиоуўэюя';
    result = result.replace(new RegExp(`(?<=[${vowels}])Ц(?=[${vowels}])`, 'g'), 'TS');
    result = result.replace(new RegExp(`(?<=[${vowels}])ц(?=[${vowels}])`, 'g'), 'ts');
    result = result.replace(/Ц/g, 'S').replace(/ц/g, 's');
    result = result.replace(/(^|\s)Е/g, '$1Ye').replace(/(^|\s)е/g, '$1ye');
    result = result.replace(/Е/g, 'E').replace(/е/g, 'e');

    const map = {
        'А': 'A', 'а': 'a', 'Б': 'B', 'б': 'b', 'В': 'V', 'в': 'v',
        'Г': 'G', 'г': 'g', 'Д': 'D', 'д': 'd', 'Ё': 'Yo', 'ё': 'yo',
        'Ж': 'J', 'ж': 'j', 'З': 'Z', 'з': 'z',
        'И': 'I', 'и': 'i', 'Й': 'Y', 'й': 'y', 'К': 'K', 'к': 'k',
        'Л': 'L', 'л': 'l', 'М': 'M', 'm': 'm', 'Н': 'N', 'н': 'n',
        'О': 'O', 'о': 'o', 'П': 'P', 'п': 'p', 'Р': 'R', 'р': 'r',
        'С': 'S', 'с': 's', 'Т': 'T', 'т': 't', 'У': 'U', 'у': 'u',
        'Ф': 'F', 'ф': 'f', 'Х': 'X', 'х': 'x', 'Ч': 'Ch', 'ч': 'ch',
        'Ш': 'Sh', 'ш': 'sh', 'Ъ': "'", 'ъ': "'", 'Ь': '', 'ь': '',
        'Ю': 'Yu', 'ю': 'yu', 'Я': 'Ya', 'я': 'ya', 'Э': 'E', 'э': 'e',
        'Ғ': "G'", 'ғ': "g'", 'Қ': 'Q', 'қ': 'q', 'Ҳ': 'H', 'ҳ': 'h', 'Ў': "O'", 'ў': "o'"
    };
    return result.split('').map(char => map[char] || char).join('');
}

function transliterateToCyrillic(text) {
    if (!text) return '';
    let result = text;
    const complexRules = [
        [/O[''`'’]/g, 'Ў'], [/o[''`'’]/g, 'ў'],
        [/G[''`'’]/g, 'Ғ'], [/g[''`'’]/g, 'ғ'],
        [/Yo/g, 'Ё'], [/yo/g, 'ё'], [/Yu/g, 'Ю'], [/yu/g, 'ю'],
        [/Ya/g, 'Я'], [/ya/g, 'я'], [/Ch/g, 'Ч'], [/ch/g, 'ч'], [/Sh/g, 'Ш'], [/sh/g, 'ш']
    ];
    complexRules.forEach(([regex, replaceWith]) => { result = result.replace(regex, replaceWith); });
    const singleMap = {
        'A': 'А', 'a': 'а', 'B': 'Б', 'b': 'б', 'D': 'Д', 'd': 'д',
        'F': 'Ф', 'f': 'ф', 'G': 'Г', 'g': 'г', 'H': 'Ҳ', 'h': 'ҳ',
        'I': 'И', 'i': 'и', 'J': 'Ж', 'j': 'ж', 'K': 'К', 'k': 'к',
        'L': 'Л', 'l': 'л', 'M': 'М', 'm': 'м', 'N': 'Н', 'n': 'н',
        'O': 'О', 'o': 'о', 'P': 'П', 'p': 'п', 'Q': 'Қ', 'q': 'қ',
        'R': 'Р', 'r': 'р', 'S': 'С', 's': 'с', 'T': 'Т', 't': 'т',
        'U': 'У', 'u': 'у', 'V': 'В', 'v': 'в', 'X': 'Х', 'x': 'х',
        'Z': 'З', 'z': 'з', 'E': 'Е', 'e': 'е', "'": 'ъ', '’': 'ъ', '`': 'ъ'
    };
    return result.split('').map(char => singleMap[char] || char).join('');
}

app.post('/api/transliterate', async (req, res) => {
    try {
        const { text, direction } = req.body;
        if (!text || !text.trim()) return res.json({ result: '' });
        let result = direction === 'lat2cyr' ? await transliterateWithAI(text) : transliterateToLatin(text);
        return res.json({ result });
    } catch (error) {
        const fallbackResult = req.body.direction === 'lat2cyr' ? transliterateToCyrillic(req.body.text) : transliterateToLatin(req.body.text);
        return res.json({ result: fallbackResult });
    }
});

app.post('/api/check-grammar', async (req, res) => {
    try {
        const { text } = req.body;
        if (!text || !text.trim()) return res.json({ result: 'Матн киритилмади.' });
        const result = await fixGrammar(text);
        return res.json({ result });
    } catch (error) {
        return res.status(500).json({ error: 'Ошибка проверки грамматики' });
    }
});

app.post('/api/check-file', upload.single('document'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Fayl yuklanmadi' });
        const userId = parseInt(req.body.userId) || parseInt(req.query.userId) || 1;
        const fileName = req.file.originalname.toLowerCase();
        const inputBuffer = req.file.buffer;

        const pages = await getDocumentPageCount(inputBuffer, req.file.originalname);
        const balance = getBalance(userId);

        if (balance < pages) {
            return res.status(400).json({ error: `Yetarli tanga yo'q. Kerak: ${pages}, Balans: ${balance}` });
        }

        try {
            spendCoins(userId, pages, `Проверка файла: ${req.file.originalname}`);
        } catch (err) {
            return res.status(400).json({ error: 'Yetarli tanga yo\'q' });
        }

        let outputBuffer, outputFilename, contentType;
        if (fileName.endsWith('.docx')) {
            outputBuffer = await processDocxWithProgress(inputBuffer, () => {});
            outputFilename = `tahrirlangan_${req.file.originalname}`;
            contentType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        } else if (fileName.endsWith('.txt') || fileName.endsWith('.pdf') || fileName.endsWith('.doc')) {
            let textContent = '';
            if (fileName.endsWith('.txt')) textContent = inputBuffer.toString('utf-8');
            else if (fileName.endsWith('.pdf')) { const p = await pdfParse(inputBuffer); textContent = p.text; }
            else if (fileName.endsWith('.doc')) { const e = await extractor.extract(inputBuffer); textContent = e.getBody(); }

            const fixedResult = await fixGrammar(textContent);
            const parsed = typeof fixedResult === 'string' ? JSON.parse(fixedResult) : fixedResult;
            outputBuffer = Buffer.from(parsed.cleanText || textContent, 'utf-8');
            outputFilename = `tahrirlangan_${req.file.originalname}.txt`;
            contentType = 'text/plain; charset=utf-8';
        } else {
            addCoins(userId, pages, 'Возврат: формат не поддерживается');
            return res.status(400).json({ error: 'Faqat .docx, .doc, .txt, .pdf formatlari qoʻllab-quvvatlanadi' });
        }

        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Disposition', `attachment; filename="${outputFilename}"`);
        res.send(outputBuffer);
    } catch (error) {
        return res.status(500).json({ error: 'Faylni qayta ishlashda xatolik yuz berdi' });
    }
});

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ============================================================
// Инициализация базы данных и Запуск сервера
// ============================================================
initDatabase().then(() => {
    const PORT = process.env.PORT || 5000;
    app.listen(PORT, () => {
        console.log(`🚀 Сервер запущен на http://localhost:${PORT}`);
        console.log(`💳 Платежные эндпоинты настроены (/api/payment/..., /api/webhook/sms)`);
    });
}).catch(err => {
    console.error('Ошибка инициализации базы данных:', err);
    process.exit(1);
});