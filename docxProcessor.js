const PizZip = require('pizzip');
const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');
const { checkWrongWordsBatch } = require('./grammar');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const UZ_ALPHA = "a-zA-Zа-яА-ЯўЎғҒҳҲқҚёЁъЪьЬʻʼ'’‘`\\-";

function renderProgressBar(percent) {
    const totalBlocks = 10;
    const filledBlocks = Math.round((percent / 100) * totalBlocks);
    const emptyBlocks = totalBlocks - filledBlocks;
    return '█'.repeat(filledBlocks) + '▒'.repeat(emptyBlocks) + ` ${percent}%`;
}

function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Разделяет <w:r> на части и подсвечивает ТОЛЬКО ошибочное слово
 */
function highlightExactWordInRun(xmlDoc, runNode, tNode, word, wordStartInNode, wordEndInNode) {
    const fullText = tNode.textContent;
    const before = fullText.substring(0, wordStartInNode);
    const errorWord = fullText.substring(wordStartInNode, wordEndInNode);
    const after = fullText.substring(wordEndInNode);

    const parentNode = runNode.parentNode;
    if (!parentNode) return;

    // Собираем оставшиеся <w:t> (кроме текущего)
    const otherTNodes = Array.from(runNode.getElementsByTagName('w:t'))
        .filter(t => t !== tNode);

    // Создаём фрагмент для вставки
    const fragment = xmlDoc.createDocumentFragment();

    // 1. Текст до ошибки
    if (before.length > 0) {
        const beforeRun = runNode.cloneNode(false);
        while (beforeRun.firstChild) beforeRun.removeChild(beforeRun.firstChild);
        
        copyRunPropertiesWithoutHighlight(xmlDoc, runNode, beforeRun);
        
        const beforeT = xmlDoc.createElement('w:t');
        beforeT.setAttribute('xml:space', 'preserve');
        beforeT.textContent = before;
        beforeRun.appendChild(beforeT);
        fragment.appendChild(beforeRun);
    }

    // 2. Ошибочное слово С ПОДСВЕТКОЙ
    const errorRun = runNode.cloneNode(false);
    while (errorRun.firstChild) errorRun.removeChild(errorRun.firstChild);
    
    copyRunPropertiesWithHighlight(xmlDoc, runNode, errorRun);
    
    const errorT = xmlDoc.createElement('w:t');
    errorT.setAttribute('xml:space', 'preserve');
    errorT.textContent = errorWord;
    errorRun.appendChild(errorT);
    
    // Копируем остальные <w:t> в error run
    for (const otherT of otherTNodes) {
        errorRun.appendChild(otherT.cloneNode(true));
    }
    fragment.appendChild(errorRun);

    // 3. Текст после ошибки
    if (after.length > 0) {
        const afterRun = runNode.cloneNode(false);
        while (afterRun.firstChild) afterRun.removeChild(afterRun.firstChild);
        
        copyRunPropertiesWithoutHighlight(xmlDoc, runNode, afterRun);
        
        const afterT = xmlDoc.createElement('w:t');
        afterT.setAttribute('xml:space', 'preserve');
        afterT.textContent = after;
        afterRun.appendChild(afterT);
        fragment.appendChild(afterRun);
    }

    // Заменяем оригинальный run на фрагмент
    parentNode.replaceChild(fragment, runNode);
}

function copyRunPropertiesWithoutHighlight(xmlDoc, sourceRun, targetRun) {
    const sourceRPr = sourceRun.getElementsByTagName('w:rPr')[0];
    
    if (sourceRPr) {
        const newRPr = xmlDoc.createElement('w:rPr');
        const children = Array.from(sourceRPr.childNodes);
        for (const child of children) {
            if (child.nodeName === 'w:highlight') continue;
            newRPr.appendChild(child.cloneNode(true));
        }
        if (newRPr.childNodes.length > 0) {
            targetRun.appendChild(newRPr);
        }
    }
}

function copyRunPropertiesWithHighlight(xmlDoc, sourceRun, targetRun) {
    const sourceRPr = sourceRun.getElementsByTagName('w:rPr')[0];
    const newRPr = xmlDoc.createElement('w:rPr');
    
    if (sourceRPr) {
        const children = Array.from(sourceRPr.childNodes);
        for (const child of children) {
            if (child.nodeName === 'w:highlight') continue;
            newRPr.appendChild(child.cloneNode(true));
        }
    }
    
    const highlight = xmlDoc.createElement('w:highlight');
    highlight.setAttribute('w:val', 'yellow');
    newRPr.appendChild(highlight);
    
    targetRun.appendChild(newRPr);
}

/**
 * ИСПРАВЛЕНО: Подсветка ВСЕХ ошибок в абзаце
 * Проблема была в `return` внутри цикла — он прерывал обработку после первой ошибки
 */
/**
 * ИСПРАВЛЕНО: Подсветка ВСЕХ ошибок в абзаце
 * 1. Собираем все позиции всех ошибочных слов
 * 2. Сортируем с конца текста к началу
 * 3. После каждой замены пересобираем runData
 */
function highlightWrongWordsInParagraph(xmlDoc, paragraphNode, wrongWords) {
    if (!wrongWords || wrongWords.length === 0) return;

    // === ШАГ 1: Собираем все позиции всех ошибочных слов ===
    const runs = Array.from(paragraphNode.getElementsByTagName('w:r'));
    if (runs.length === 0) return;

    const initialRunData = runs.map(run => {
        const tNodes = Array.from(run.getElementsByTagName('w:t'));
        return {
            run: run,
            tNodes: tNodes,
            text: tNodes.map(t => t.textContent || '').join('')
        };
    }).filter(d => d.text.length > 0);

    if (initialRunData.length === 0) return;

    const fullText = initialRunData.map(d => d.text).join('');

    // Собираем все совпадения: { word, start, end }
    const allMatches = [];

    for (const word of wrongWords) {
        if (!word || word.trim().length < 3) continue;

        const cleanWord = word.trim();
        const escaped = escapeRegExp(cleanWord);

        const wordRegex = new RegExp(
            `(?<![${UZ_ALPHA}])(${escaped})(?![${UZ_ALPHA}])`,
            'gi'
        );

        let match;
        while ((match = wordRegex.exec(fullText)) !== null) {
            allMatches.push({
                word: cleanWord,
                start: match.index,
                end: match.index + match[0].length
            });
        }
    }

    if (allMatches.length === 0) {
        console.log('  Нет совпадений для подсветки');
        return;
    }

    // === ШАГ 2: Сортируем С КОНЦА (чтобы позиции не сдвигались) ===
    allMatches.sort((a, b) => b.start - a.start);

    console.log(`  Найдено ${allMatches.length} совпадений для подсветки`);

    // === ШАГ 3: Обрабатываем каждое совпадение ===
    for (const matchInfo of allMatches) {
        const { word, start: matchStart, end: matchEnd } = matchInfo;

        // ЗАНОВО собираем runData, т.к. DOM изменился после предыдущей замены
        const currentRuns = Array.from(paragraphNode.getElementsByTagName('w:r'));
        const currentRunData = currentRuns.map(run => {
            const tNodes = Array.from(run.getElementsByTagName('w:t'));
            return {
                run: run,
                tNodes: tNodes,
                text: tNodes.map(t => t.textContent || '').join('')
            };
        }).filter(d => d.text.length > 0);

        const currentFullText = currentRunData.map(d => d.text).join('');

        // Проверяем, что позиция всё ещё валидна
        if (matchStart >= currentFullText.length) {
            console.log(`  Пропуск "${word}" — позиция ${matchStart} за пределами текста (длина: ${currentFullText.length})`);
            continue;
        }

        // Находим run и tNode для этого совпадения
        let currentPos = 0;
        let found = false;

        for (const data of currentRunData) {
            const runStart = currentPos;
            const runEnd = currentPos + data.text.length;

            if (matchStart < runEnd && matchEnd > runStart) {
                const wordStartInFullRun = Math.max(0, matchStart - runStart);
                const wordEndInFullRun = Math.min(data.text.length, matchEnd - runStart);

                let tNodePos = 0;
                for (const tNode of data.tNodes) {
                    const tText = tNode.textContent || '';
                    const tStart = tNodePos;
                    const tEnd = tNodePos + tText.length;

                    if (wordStartInFullRun < tEnd && wordEndInFullRun > tStart) {
                        const wordStartInTNode = Math.max(0, wordStartInFullRun - tStart);
                        const wordEndInTNode = Math.min(tText.length, wordEndInFullRun - tStart);

                        // Проверяем, что run ещё в DOM
                        if (data.run.parentNode) {
                            console.log(`  Подсветка "${word}" в позиции ${matchStart}-${matchEnd} (run: "${data.text.substring(0, 30)}...")`);
                            highlightExactWordInRun(
                                xmlDoc, data.run, tNode, word,
                                wordStartInTNode, wordEndInTNode
                            );
                            found = true;
                        }
                        break;
                    }
                    tNodePos = tEnd;
                }
                if (found) break;
            }
            currentPos = runEnd;
        }

        if (!found) {
            console.log(`  Не удалось найти "${word}" в DOM после изменений`);
        }
    }
}

/**
 * Главная функция обработки DOCX
 */
async function processDocxWithProgress(fileBuffer, onProgressUpdate) {
    const zip = new PizZip(fileBuffer);
    const documentXmlContent = zip.file("word/document.xml").asText();

    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(documentXmlContent, "text/xml");

    const paragraphs = Array.from(xmlDoc.getElementsByTagName('w:p'));
    
    const validParagraphs = paragraphs.filter(p => {
        const text = p.textContent || '';
        return text.trim().length > 0;
    });

    if (validParagraphs.length === 0) {
        const serializer = new XMLSerializer();
        const updatedXml = serializer.serializeToString(xmlDoc);
        zip.file("word/document.xml", updatedXml);
        return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
    }

    const BATCH_SIZE = 8;
    const totalBatches = Math.ceil(validParagraphs.length / BATCH_SIZE);

    for (let i = 0; i < validParagraphs.length; i += BATCH_SIZE) {
        const batchParagraphs = validParagraphs.slice(i, i + BATCH_SIZE);
        const batchTexts = batchParagraphs.map(p => (p.textContent || '').trim());

        try {
            const results = await checkWrongWordsBatch(batchTexts);

            // ИСПРАВЛЕНО: обрабатываем абзацы в обратном порядке
            // чтобы изменения в DOM не ломали индексы
            for (let idx = batchParagraphs.length - 1; idx >= 0; idx--) {
                const result = results[idx];
                if (result && result.wrongWords && result.wrongWords.length > 0) {
                    console.log(`  Подсветка в абзаце ${i + idx}:`, result.wrongWords);
                    highlightWrongWordsInParagraph(xmlDoc, batchParagraphs[idx], result.wrongWords);
                }
            }

        } catch (error) {
            console.error(`Ошибка при обработке пакета абзацев ${i}-${i + BATCH_SIZE}:`, error.message);
            // Сбой AI нельзя скрывать: иначе пользователь получит файл без проверки
            if (error.aiFailure) throw error;
        }

        const currentBatchNum = Math.floor(i / BATCH_SIZE) + 1;
        const currentPercent = Math.floor((currentBatchNum / totalBatches) * 100);

        if (onProgressUpdate && typeof onProgressUpdate === 'function') {
            await onProgressUpdate(currentPercent, renderProgressBar(currentPercent));
        }

        await sleep(300);
    }

    const serializer = new XMLSerializer();
    const updatedXml = serializer.serializeToString(xmlDoc);
    zip.file("word/document.xml", updatedXml);

    return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

module.exports = { processDocxWithProgress, renderProgressBar };