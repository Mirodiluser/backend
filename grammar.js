require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');

if (!process.env.GEMINI_API_KEY) {
    console.error('❌ GEMINI_API_KEY .env faylida koʻrsatilmagan: imlo tekshiruvi ishlamaydi');
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const modelText = genAI.getGenerativeModel({
    model: 'gemini-3.5-flash-lite',
    generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.0,
    }
});

const modelBatch = genAI.getGenerativeModel({
    model: 'gemini-3.5-flash-lite',
    generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.0,
    }
});

// Модель для текстовой транслитерации через AI
const modelTranslit = genAI.getGenerativeModel({
    model: 'gemini-3.5-flash-lite',
    generationConfig: {
        temperature: 0.1,
    }
});

// Модель для верификации (более осторожная)
const modelVerify = genAI.getGenerativeModel({
    model: 'gemini-3.5-flash-lite',
    generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.0,
    }
});

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Узбекские + русские буквы + апострофы + дефис
const UZ_ALPHA = "a-zA-Zа-яА-ЯўЎғҒҳҲқҚёЁъЪьЬʻʼ'’‘`\\-";

// Буквы, НЕ входящие в узбекский алфавит (иностранные)
const NON_UZBEK = "ыөүәіңҷһЫӨҮӘІҢҶҺ";

function extractRealWords(text) {
    if (!text) return [];
    const words = [];
    const regex = new RegExp(`[^${UZ_ALPHA}]+`);
    const tokens = text.split(regex);
    for (const token of tokens) {
        const cleaned = token.trim();
        if (cleaned.length >= 3 && /[a-zA-Zа-яА-ЯўЎғҒҳҲқҚёЁ]/.test(cleaned)) {
            words.push(cleaned);
        }
    }
    return words;
}

function isValidErrorWord(candidate, originalText) {
    if (!candidate || !originalText) return false;
    const word = candidate.trim();
    if (/\s/.test(word)) return false;
    if (word.length < 3) return false;
    if (/[''`'’]/.test(word)) return false;
    if (new RegExp(`[${NON_UZBEK}]`).test(word)) return false;
    if (/[.,!?;:()\[\]{}«»"“”]/.test(word)) return false;
    
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const standaloneRegex = new RegExp(
        `(?<![${UZ_ALPHA}])(${escaped})(?![${UZ_ALPHA}])`,
        'gi'
    );
    
    if (!standaloneRegex.test(originalText)) return false;
    
    standaloneRegex.lastIndex = 0;
    const allMatches = [];
    let match;
    while ((match = standaloneRegex.exec(originalText)) !== null) {
        const start = match.index;
        const end = start + match[0].length;
        const charBefore = start > 0 ? originalText[start - 1] : ' ';
        const charAfter = end < originalText.length ? originalText[end] : ' ';
        const isBeforeAlpha = new RegExp(`[${UZ_ALPHA}]`).test(charBefore);
        const isAfterAlpha = new RegExp(`[${UZ_ALPHA}]`).test(charAfter);
        allMatches.push({ start, end, isStandalone: !isBeforeAlpha && !isAfterAlpha });
    }
    
    if (allMatches.length > 0 && allMatches.every(m => !m.isStandalone)) {
        return false;
    }
    return true;
}

function filterWrongWords(rawWords, originalText) {
    if (!Array.isArray(rawWords)) return [];
    const realWords = extractRealWords(originalText);
    const realWordsLower = new Set(realWords.map(w => w.toLowerCase()));
    const result = [];
    
    for (const raw of rawWords) {
        if (typeof raw !== 'string') continue;
        let word = raw.trim();
        word = word.replace(/^["“'«`„‚«‹]+|["”'»`“»›]+$/g, '').trim();
        
        if (word.length < 3) { console.log(`  ❌ Короткое (< 3): "${word}"`); continue; }
        if (/\s/.test(word)) { console.log(`  ❌ Фраза: "${word}"`); continue; }
        if (/[''`'’]/.test(word)) { console.log(`  ❌ Апостроф: "${word}"`); continue; }
        if (new RegExp(`[${NON_UZBEK}]`).test(word)) { console.log(`  ❌ Иностранное: "${word}"`); continue; }
        if (/[.,!?;:()\[\]{}«»"“”]/.test(word)) { console.log(`  ❌ Пунктуация: "${word}"`); continue; }
        if (!isValidErrorWord(word, originalText)) { console.log(`  ❌ Не слово/часть составного: "${word}"`); continue; }
        if (!realWordsLower.has(word.toLowerCase())) { console.log(`  ❌ Нет в тексте: "${word}"`); continue; }
        
        console.log(`  ✅ Принято: "${word}"`);
        result.push(word);
    }
    return [...new Set(result)];
}

function cleanOutputWords(words) {
    if (!Array.isArray(words)) return [];
    return words
        .filter(w => typeof w === 'string' && w.trim().length > 2)
        .map(w => w.trim().replace(/^["“'«`„‚]+|["”'»`“]+$/g, ''));
}

function cleanJsonResponse(text) {
    return text
        .replace(/```json\s*/gi, '')
        .replace(/```\s*/gi, '')
        .replace(/,(\s*[}\]])/g, '$1')
        .trim();
}

function safeJsonParse(text) {
    if (!text || typeof text !== 'string') return null;
    let cleaned = text.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').replace(/,(\s*[}\]])/g, '$1').trim();
    try { return JSON.parse(cleaned); } catch (e1) {}
    try {
        const start = cleaned.indexOf('[');
        const end = cleaned.lastIndexOf(']');
        if (start !== -1 && end !== -1 && end > start) return JSON.parse(cleaned.substring(start, end + 1));
    } catch (e2) {}
    try {
        const start = cleaned.indexOf('{');
        const end = cleaned.lastIndexOf('}');
        if (start !== -1 && end !== -1 && end > start) return JSON.parse(cleaned.substring(start, end + 1));
    } catch (e3) {}
    return null;
}

/**
 * Верификация слов через Gemini (второй уровень)
 * Переспрашивает: это реальная ошибка или правильное слово?
 */
async function verifyWordsBatch(wordsToVerify) {
    if (!wordsToVerify || wordsToVerify.length === 0) return [];
    
    // Удаляем дубликаты
    const uniqueWords = [...new Set(wordsToVerify)];
    
    const prompt = `
You are an Uzbek language expert. I will give you a list of words. For each word, determine:

- "correct" = the word is spelled correctly in Uzbek (even if you haven't seen it before)
- "error" = the word has a clear spelling mistake

CRITICAL: 
- If you are UNSURE about a word → mark it "correct"
- If the word looks like it could be a valid Uzbek word → mark it "correct"  
- Technical terms, compound words, borrowings → mark "correct"
- ONLY mark "error" if there is a 100% clear spelling mistake

Return JSON array:
[
  {"word": "word1", "status": "correct"},
  {"word": "word2", "status": "error"}
]

Words: ${JSON.stringify(uniqueWords)}
`;

    try {
        const result = await modelVerify.generateContent(prompt);
        const responseText = result.response.text();
        const parsed = safeJsonParse(responseText);
        
        if (Array.isArray(parsed)) {
            const errorWords = parsed
                .filter(item => item.status === 'error')
                .map(item => item.word);
            const correctWords = parsed
                .filter(item => item.status === 'correct')
                .map(item => item.word);
            
            console.log(`    Верификация: ошибки: [${errorWords.join(', ')}], правильно: [${correctWords.join(', ')}]`);
            return errorWords;
        }
        return wordsToVerify; // Если не удалось проверить — возвращаем как есть
    } catch (error) {
        console.error(`    Ошибка верификации:`, error.message);
        return wordsToVerify; // При ошибке возвращаем исходный список
    }
}

/**
 * Проверка текста (с двухуровневой верификацией)
 */
async function fixGrammar(text) {
    if (!text || !text.trim()) {
        return JSON.stringify({ hasErrors: false, message: 'Matn kiritilmadi.' });
    }

    // Определяем скрипт
    const isCyrillic = /[а-яА-ЯўЎғҒҳҲқҚёЁ]/.test(text);

    const prompt = `
You are an Uzbek spell checker. Find ONLY clearly misspelled words.

${isCyrillic ? 'TEXT IS IN CYRILLIC UZBEK. Check Cyrillic spelling.' : 'TEXT IS IN LATIN UZBEK. Check Latin spelling.'}

RULES:
1. Return ONLY words with OBVIOUS spelling errors
2. If UNSURE about a word → SKIP it
3. Compound words, technical terms → SKIP
4. Words with apostrophe → SKIP
5. Names, abbreviations → SKIP

Return JSON:
{
  "hasErrors": true/false,
  "corrections": [{"wrong": "word", "correct": "fix"}],
  "correctedText": "corrected text"
}

Text: "${text}"
`;

    try {
        const result = await modelText.generateContent(prompt);
        const responseText = result.response.text();
        const data = safeJsonParse(responseText);

        if (!data || !data.corrections) {
            return JSON.stringify({ hasErrors: false, message: "✅ Matnda xatoliklar topilmadi!", cleanText: text });
        }

        // Фильтр 1: убираем wrong === correct
        let validCorrections = (data.corrections || []).filter(c => {
            if (!c.wrong || !c.correct) return false;
            return c.wrong.trim().toLowerCase() !== c.correct.trim().toLowerCase();
        });

        if (validCorrections.length === 0) {
            return JSON.stringify({ hasErrors: false, message: "✅ Matnda xatoliklar topilmadi!", cleanText: text });
        }

        // Алгоритмическая фильтрация
        const rawWords = validCorrections.map(c => c.wrong);
        const filteredWords = filterWrongWords(rawWords, text);
        
        // Верификация через AI
        let verifiedWords = filteredWords;
        if (filteredWords.length > 0) {
            verifiedWords = await verifyWordsBatch(filteredWords);
        }
        
        validCorrections = validCorrections.filter(c => verifiedWords.includes(c.wrong));

        if (validCorrections.length === 0) {
            return JSON.stringify({ hasErrors: false, message: "✅ Matnda xatoliklar topilmadi!", cleanText: text });
        }

        return JSON.stringify({
            hasErrors: true,
            corrections: validCorrections,
            cleanText: data.correctedText || text
        });

    } catch (e) {
        console.error("fixGrammar xatosi:", e);
        // Не маскируем сбой AI под «ошибок нет»: вызывающий код сообщит пользователю и вернёт монеты
        e.aiFailure = true;
        throw e;
    }
}

/**
 * Пакетная проверка DOCX (с двухуровневой верификацией)
 */
async function checkWrongWordsBatch(textArray, retries = 3) {
    if (!textArray || !Array.isArray(textArray) || textArray.length === 0) return [];

    const prompt = `
You are an Uzbek spell checker. Find ONLY individual misspelled words.

CRITICAL:
- Return ONLY single words (NO spaces, NO phrases)
- Words with apostrophe → SKIP (always correct)
- Names, terms, abbreviations → SKIP
- If UNSURE about a word → SKIP it
- Compound words → SKIP
- Both Latin and Cyrillic Uzbek

Return JSON array of ${textArray.length} objects: [{"wrongWords": ["word"]}, {"wrongWords": []}]

Texts:
${JSON.stringify(textArray, null, 2)}
`;

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const result = await modelBatch.generateContent(prompt);
            const responseText = result.response.text();
            
            console.log(`\n=== Пакет ${attempt} ===`);
            console.log(responseText.substring(0, 500));
            console.log(`=== Конец ===\n`);
            
            const parsed = safeJsonParse(responseText);
            
            if (parsed && Array.isArray(parsed)) {
                console.log(`✅ Парсинг успешен! ${parsed.length} элементов`);
                
                // Сначала собираем все wrongWords со всех абзацев
                const allWords = [];
                const paragraphMap = []; // для каждого слова храним индекс абзаца
                
                for (let i = 0; i < textArray.length; i++) {
                    const item = parsed[i] || { wrongWords: [] };
                    const originalText = textArray[i];
                    const rawWords = cleanOutputWords(item?.wrongWords || []);
                    const filteredWords = filterWrongWords(rawWords, originalText);
                    
                    for (const word of filteredWords) {
                        allWords.push(word);
                        paragraphMap.push(i);
                    }
                }
                
                // Верификация ВСЕХ слов одним запросом
                let verifiedWords = allWords;
                if (allWords.length > 0) {
                    console.log(`  Слов для верификации: ${allWords.length}`);
                    verifiedWords = await verifyWordsBatch(allWords);
                }
                
                // Распределяем верифицированные слова обратно по абзацам
                const finalResult = textArray.map(() => ({ wrongWords: [] }));
                for (let j = 0; j < allWords.length; j++) {
                    if (verifiedWords.includes(allWords[j])) {
                        const paragraphIdx = paragraphMap[j];
                        finalResult[paragraphIdx].wrongWords.push(allWords[j]);
                    }
                }
                
                // Убираем дубликаты в каждом абзаце
                for (let i = 0; i < finalResult.length; i++) {
                    finalResult[i].wrongWords = [...new Set(finalResult[i].wrongWords)];
                    if (finalResult[i].wrongWords.length > 0) {
                        console.log(`  Абзац ${i}: итого ошибок: [${finalResult[i].wrongWords.join(', ')}]`);
                    }
                }
                
                return finalResult;
            }
            
            console.error('❌ Ответ не массив');
            
        } catch (error) {
            console.error(`❌ Ошибка (попытка ${attempt}):`, error.message);
        }
        
        if (attempt < retries) {
            await sleep(1500 * attempt);
        }
    }
    
    // Все попытки не удались: это сбой AI, а не «ошибок нет»
    const err = new Error('Gemini javob bermadi (kalit, kvota yoki model nomini tekshiring)');
    err.aiFailure = true;
    throw err;
}

/**
 * Умная транслитерация текста через Gemini AI (Латиница ➔ Кириллица)
 */
async function transliterateWithAI(text) {
    if (!text || !text.trim()) return '';

    const prompt = `
Ты — филолог узбекского языка. Твоя задача — точно перевести данный текст с узбекской ЛАТИНИЦЫ на узбекскую КИРИЛЛИЦУ.

Правила:
1. Сохраняй структуру, пунктуацию и регистр.
2. Возвращай ТОЛЬКО чисто переведенный текст без каких-либо комментариев и кавычек.

Текст:
${text}
`;

    try {
        const result = await modelTranslit.generateContent(prompt);
        const responseText = result.response.text();
        return responseText.trim();
    } catch (e) {
        console.error("Ошибка transliterateWithAI:", e);
        throw e;
    }
}

module.exports = {
    fixGrammar,
    checkWrongWordsBatch,
    transliterateWithAI
};