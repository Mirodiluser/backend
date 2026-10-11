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
const { execFile, execFileSync } = require('child_process');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
    console.error('❌ JWT_SECRET .env faylida koʻrsatilmagan');
    process.exit(1);
}

const SMS_WEBHOOK_SECRET = process.env.SMS_WEBHOOK_SECRET;

// Tanga paketlari: narx va tangalar faqat serverda belgilanadi
const COIN_PACKAGES = {
    pkg_15: { price: 7990, coins: 15 },
    pkg_50: { price: 22990, coins: 55 },
    pkg_100: { price: 42990, coins: 115 },
    pkg_250: { price: 99990, coins: 290 },
    pkg_500: { price: 169990, coins: 580 },
    pkg_1200: { price: 309990, coins: 1150 },
};

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
    createOrder,
    getOrder,
    findPendingOrder,
    markOrderPaid
} = require('./database');

const { fixGrammar, transliterateWithAI } = require('./grammar');
const { processDocxWithProgress } = require('./docxProcessor');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Проверка JWT: Authorization: Bearer <token>
function requireAuth(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Avval tizimga kiring' });
    try {
        const payload = jwt.verify(token, JWT_SECRET);
        req.userId = parseInt(payload.id);
        if (!req.userId) throw new Error('bad token');
        return next();
    } catch (e) {
        return res.status(401).json({ error: 'Sessiya muddati tugagan, qaytadan kiring' });
    }
}

function safeEqual(a, b) {
    const bufA = Buffer.from(String(a));
    const bufB = Buffer.from(String(b));
    return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

// ============================================================
// Поиск LibreOffice (soffice.exe)
// ============================================================
function findLibreOffice() {
    if (process.env.LIBREOFFICE_PATH && fs.existsSync(process.env.LIBREOFFICE_PATH)) {
        return process.env.LIBREOFFICE_PATH;
    }

    const possiblePaths = process.platform === 'win32' ? [
        'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
        'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
        path.join(os.homedir(), 'Desktop', 'LibreOffice', 'program', 'soffice.exe'),
        path.join(os.homedir(), 'Desktop', 'LibreOfficePortable', 'App', 'libreoffice', 'program', 'soffice.exe'),
        path.join(os.homedir(), 'OneDrive', 'Desktop', 'LibreOffice', 'program', 'soffice.exe'),
        path.join(os.homedir(), 'OneDrive', 'Рабочий стол', 'LibreOffice', 'program', 'soffice.exe'),
        'D:\\LibreOffice\\program\\soffice.exe',
        'E:\\LibreOffice\\program\\soffice.exe',
    ] : [
        '/usr/bin/soffice',
        '/usr/bin/libreoffice',
        '/usr/local/bin/soffice',
        '/usr/lib/libreoffice/program/soffice',
        '/opt/libreoffice/program/soffice',
        '/snap/bin/libreoffice',
        '/Applications/LibreOffice.app/Contents/MacOS/soffice',
    ];

    for (const p of possiblePaths) {
        if (fs.existsSync(p)) {
            console.log(`✅ LibreOffice topildi: ${p}`);
            return p;
        }
    }

    const lookup = process.platform === 'win32' ? ['where', ['soffice']] : ['which', ['soffice', 'libreoffice']];
    try {
        const result = execFileSync(lookup[0], lookup[1], { encoding: 'utf-8' });
        const found = result.trim().split(/\r?\n/)[0];
        if (found) {
            console.log(`✅ LibreOffice topildi (PATH): ${found}`);
            return found.trim();
        }
    } catch (e) {}

    console.error('❌ LibreOffice (soffice) topilmadi');
    return null;
}

// Конвертация через LibreOffice. Имя файла пользователя не попадает ни в путь, ни в команду.
async function convertWithLibreOffice(buffer, inputExt, targetExt, extraArgs = [], timeout = 120000) {
    const libreOfficePath = findLibreOffice();
    if (!libreOfficePath) throw new Error('LibreOffice topilmadi');

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'convert_'));
    try {
        const inputPath = path.join(tempDir, `input${inputExt}`);
        fs.writeFileSync(inputPath, buffer);

        await new Promise((resolve, reject) => {
            execFile(
                libreOfficePath,
                ['--headless', ...extraArgs, '--convert-to', targetExt, '--outdir', tempDir, inputPath],
                { timeout },
                (error) => error ? reject(new Error(`LibreOffice xatosi: ${error.message}`)) : resolve()
            );
        });

        const outputPath = path.join(tempDir, `input.${targetExt}`);
        if (!fs.existsSync(outputPath)) throw new Error(`${targetExt.toUpperCase()} yaratilmadi`);
        return fs.readFileSync(outputPath);
    } finally {
        fs.rm(tempDir, { recursive: true, force: true }, () => {});
    }
}

// Безопасный заголовок Content-Disposition (UTF-8 имена файлов)
function attachmentHeader(filename) {
    const ascii = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
    return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
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

app.get('/api/auth/me', requireAuth, (req, res) => {
    try {
        const user = getUser(req.userId);
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

// 1. Создание заказа на оплату (сумма и монеты берутся из серверного списка пакетов)
app.post('/api/payment/create-order', requireAuth, (req, res) => {
    try {
        const { packageId } = req.body;
        const pkg = COIN_PACKAGES[packageId];
        if (!pkg) {
            return res.status(400).json({ error: 'Paket topilmadi' });
        }

        const orderId = `ord_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
        createOrder(orderId, req.userId, packageId, pkg.price, pkg.coins);

        console.log(`💳 Yangi buyurtma yaratildi: ${orderId} | Summa: ${pkg.price} so'm | Tanga: ${pkg.coins}`);
        return res.json({ success: true, orderId, amount: pkg.price, coins: pkg.coins });
    } catch (error) {
        console.error('Create order error:', error);
        return res.status(500).json({ error: 'Buyurtma yaratishda xatolik' });
    }
});

// 2. Проверка статуса заказа (только свой заказ)
app.get('/api/payment/check-status/:orderId', requireAuth, (req, res) => {
    try {
        const order = getOrder(req.params.orderId);
        if (!order || order.user_id !== req.userId) {
            return res.status(404).json({ error: 'Buyurtma topilmadi' });
        }
        return res.json({ status: order.status });
    } catch (error) {
        return res.status(500).json({ error: 'Server xatosi' });
    }
});

// 3. Вебхук для приема SMS от телефона. Требует секрет: заголовок X-Webhook-Secret или ?secret=
app.post('/api/webhook/sms', (req, res) => {
    try {
        if (!SMS_WEBHOOK_SECRET) {
            console.error('❌ SMS_WEBHOOK_SECRET .env faylida koʻrsatilmagan, webhook oʻchirilgan');
            return res.status(503).json({ error: 'Webhook sozlanmagan' });
        }
        const provided = req.get('x-webhook-secret') || req.query.secret || '';
        if (!safeEqual(provided, SMS_WEBHOOK_SECRET)) {
            return res.status(401).json({ error: 'Ruxsat yoʻq' });
        }

        const { text } = req.body;
        if (!text) return res.status(400).json({ error: 'SMS matni topilmadi' });

        console.log(`📩 Kelgan SMS: "${text}"`);

        const cleanText = String(text).replace(/[\s,]/g, '');
        const match = cleanText.match(/(\d+)(sum|сум)/i);

        if (!match) {
            return res.status(400).json({ error: 'SMS dan summani aniqlab boʻlmadi' });
        }

        const incomingAmount = parseInt(match[1], 10);
        console.log(`💰 Aniqlangan summa: ${incomingAmount} so'm`);

        // Шаг 1: точное совпадение за последние 15 минут
        let order = findPendingOrder(incomingAmount, incomingAmount, 15);

        // Шаг 2: поиск по диапазону (+/- 100 сум) за последние 10 минут
        if (!order) {
            order = findPendingOrder(incomingAmount - 100, incomingAmount + 100, 10);
        }

        if (!order) {
            console.log(`⚠️ Mos keluvchi faol buyurtma topilmadi (${incomingAmount} so'm)`);
            return res.status(404).json({ error: 'Mos buyurtma topilmadi' });
        }

        markOrderPaid(order.id);
        addCoins(order.user_id, order.coins, `To'lov tasdiqlandi: ${order.amount} so'm`);

        console.log(`✅ To'lov muvaffaqiyatli bajarildi! Foydalanuvchi ID: ${order.user_id} | +${order.coins} tanga`);
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
            try {
                const pdfBuffer = await convertWithLibreOffice(firstFile.buffer, path.extname(ext), 'pdf');
                const baseName = path.basename(firstFile.originalname, path.extname(firstFile.originalname));
                res.setHeader('Content-Type', 'application/pdf');
                res.setHeader('Content-Disposition', attachmentHeader(`${baseName}.pdf`));
                return res.send(pdfBuffer);
            } catch (err) {
                console.error('DOC->PDF error:', err.message);
                return res.status(500).json({ error: 'PDF ga o\'girishda xatolik' });
            }
        }

        if (targetFormat === 'docx' && ext.endsWith('.pdf')) {
            try {
                const docxBuffer = await convertWithLibreOffice(firstFile.buffer, '.pdf', 'docx', ['--infilter=writer_pdf_import'], 180000);
                const baseName = path.basename(firstFile.originalname, path.extname(firstFile.originalname));
                res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
                res.setHeader('Content-Disposition', attachmentHeader(`${baseName}.docx`));
                return res.send(docxBuffer);
            } catch (err) {
                console.error('PDF->DOCX error:', err.message);
                return res.status(500).json({ error: 'PDF ni DOCX ga o\'girishda xatolik' });
            }
        }

        if (targetFormat === 'txt' && ext.endsWith('.pdf')) {
            try {
                const pdfData = await pdfParse(firstFile.buffer);
                const baseName = path.basename(firstFile.originalname, '.pdf');
                res.setHeader('Content-Type', 'text/plain; charset=utf-8');
                res.setHeader('Content-Disposition', attachmentHeader(`${baseName}.txt`));
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
                res.setHeader('Content-Disposition', attachmentHeader(`${baseName}.txt`));
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
app.get('/api/wallet', requireAuth, (req, res) => {
    try {
        const stats = getStats(req.userId);
        const transactions = getTransactions(req.userId, 10);
        res.json({ ...stats, transactions });
    } catch (error) {
        res.status(500).json({ error: error.message });
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

app.post('/api/check-file', requireAuth, upload.single('document'), async (req, res) => {
    let charged = 0;
    const userId = req.userId;
    try {
        if (!req.file) return res.status(400).json({ error: 'Fayl yuklanmadi' });
        const fileName = req.file.originalname.toLowerCase();
        const inputBuffer = req.file.buffer;

        if (!/\.(docx|doc|txt|pdf)$/.test(fileName)) {
            return res.status(400).json({ error: 'Faqat .docx, .doc, .txt, .pdf formatlari qoʻllab-quvvatlanadi' });
        }

        const pages = await getDocumentPageCount(inputBuffer, req.file.originalname);
        const balance = getBalance(userId);

        if (balance < pages) {
            return res.status(400).json({ error: `Yetarli tanga yo'q. Kerak: ${pages}, Balans: ${balance}` });
        }

        try {
            spendCoins(userId, pages, `Проверка файла: ${req.file.originalname}`);
            charged = pages;
        } catch (err) {
            return res.status(400).json({ error: 'Yetarli tanga yo\'q' });
        }

        let outputBuffer, outputFilename, contentType;
        if (fileName.endsWith('.docx')) {
            outputBuffer = await processDocxWithProgress(inputBuffer, () => {});
            outputFilename = `tahrirlangan_${req.file.originalname}`;
            contentType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        } else {
            let textContent = '';
            if (fileName.endsWith('.txt')) textContent = inputBuffer.toString('utf-8');
            else if (fileName.endsWith('.pdf')) { const p = await pdfParse(inputBuffer); textContent = p.text; }
            else if (fileName.endsWith('.doc')) { const e = await extractor.extract(inputBuffer); textContent = e.getBody(); }

            const fixedResult = await fixGrammar(textContent);
            const parsed = typeof fixedResult === 'string' ? JSON.parse(fixedResult) : fixedResult;
            outputBuffer = Buffer.from(parsed.cleanText || textContent, 'utf-8');
            outputFilename = `tahrirlangan_${req.file.originalname}.txt`;
            contentType = 'text/plain; charset=utf-8';
        }

        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Disposition', attachmentHeader(outputFilename));
        res.send(outputBuffer);
    } catch (error) {
        console.error('Check file error:', error);
        if (charged > 0) {
            try { addCoins(userId, charged, 'Возврат: ошибка обработки файла'); } catch (e) {}
        }
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