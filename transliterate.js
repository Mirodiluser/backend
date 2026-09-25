// transliterate.js

// 1. Функция перевода с латиницы на кириллицу
function transliterateToCyrillic(text) {
    if (!text) return '';

    let result = text;

    // Сложные/составные знаки и специфические буквы (важен порядок!)
    const complexRules = [
        [/[O|o]['’`ʻ‘]/g, (match) => match[0] === 'O' ? 'Ў' : 'ў'],
        [/[G|g]['’`ʻ‘]/g, (match) => match[0] === 'G' ? 'Ғ' : 'ғ'],
        [/Yo/g, 'Ё'], [/yo/g, 'ё'],
        [/Yu/g, 'Ю'], [/yu/g, 'ю'],
        [/Ya/g, 'Я'], [/ya/g, 'я'],
        [/Ch/g, 'Ч'], [/ch/g, 'ч'],
        [/Sh/g, 'Ш'], [/sh/g, 'ш'],
        [/Ye/g, 'Е'], [/ye/g, 'е'],
        [/Ts/g, 'Ц'], [/ts/g, 'ц']
    ];

    complexRules.forEach(([regex, replaceWith]) => {
        result = result.replace(regex, replaceWith);
    });

    // Начальная 'E/e' переходит в 'Э/э' (в начале слова или после гласных)
    result = result.replace(/(^|[^a-zA-Zа-яА-ЯўЎғҒҳҲқҚ])E/g, '$1Э');
    result = result.replace(/(^|[^a-zA-Zа-яА-ЯўЎғҒҳҲқҚ])e/g, '$1э');

    // Одиночные буквы
    const singleMap = {
        'A': 'А', 'a': 'а', 'B': 'Б', 'b': 'б', 'D': 'Д', 'd': 'д',
        'F': 'Ф', 'f': 'ф', 'G': 'Г', 'g': 'г', 'H': 'Ҳ', 'h': 'ҳ',
        'I': 'И', 'i': 'и', 'J': 'Ж', 'j': 'ж', 'K': 'К', 'k': 'к',
        'L': 'Л', 'l': 'л', 'M': 'М', 'm': 'м', 'N': 'Н', 'n': 'н',
        'O': 'О', 'o': 'о', 'P': 'П', 'p': 'п', 'Q': 'Қ', 'q': 'қ',
        'R': 'Р', 'r': 'р', 'S': 'С', 's': 'с', 'T': 'Т', 't': 'т',
        'U': 'У', 'u': 'у', 'V': 'В', 'v': 'в', 'X': 'Х', 'x': 'х',
        'Z': 'З', 'z': 'з', 'E': 'Е', 'e': 'е',
        "'": 'ъ', '’': 'ъ', '`': 'ъ', 'ʻ': 'ъ', '‘': 'ъ'
    };

    result = result.split('').map(char => singleMap[char] || char).join('');
    return result;
}

// 2. Функция перевода с кириллицы на латиницу
function transliterateToLatin(text) {
    if (!text) return '';

    let result = text;

    // Контекстная обработка Ц (Sivilizatsiya / Prinsiplari)
    result = result.replace(/(^|\s)Ц/g, '$1S');
    result = result.replace(/(^|\s)ц/g, '$1s');
    result = result.replace(/Ц/g, 'Ts');
    result = result.replace(/ц/g, 'ts');

    // Контекстная обработка Е (Ye в начале слова / после гласных)
    result = result.replace(/(^|\s)Е/g, '$1Ye');
    result = result.replace(/(^|\s)е/g, '$1ye');
    result = result.replace(/([АЕИОУЎаеиоуў])Е/g, '$1Ye');
    result = result.replace(/([АЕИОУЎаеиоуў])е/g, '$1ye');

    // Остальные буквы
    const map = {
        'А': 'A', 'а': 'a', 'Б': 'B', 'б': 'b', 'В': 'V', 'в': 'v',
        'Г': 'G', 'г': 'g', 'Д': 'D', 'д': 'd', 'Е': 'E', 'е': 'e',
        'Ё': 'Yo', 'ё': 'yo', 'Ж': 'J', 'ж': 'j', 'З': 'Z', 'з': 'z',
        'И': 'I', 'и': 'i', 'Й': 'Y', 'й': 'y', 'К': 'K', 'к': 'k',
        'Л': 'L', 'л': 'l', 'М': 'M', 'м': 'm', 'Н': 'N', 'н': 'n',
        'О': 'O', 'о': 'o', 'П': 'P', 'п': 'p', 'Р': 'R', 'р': 'r',
        'С': 'S', 'с': 's', 'Т': 'T', 'т': 't', 'У': 'U', 'у': 'u',
        'Ф': 'F', 'ф': 'f', 'Х': 'X', 'х': 'x', 'Ч': 'Ch', 'ч': 'ch',
        'Ш': 'Sh', 'ш': 'sh', 'Ъ': "’", 'ъ': "’", 'Ь': '', 'ь': '',
        'Ю': 'Yu', 'ю': 'yu', 'Я': 'Ya', 'я': 'ya', 
        'Э': 'E', 'э': 'e',
        'Ғ': "G‘", 'ғ': "g‘", 'Қ': 'Q', 'қ': 'q',
        'Ҳ': 'H', 'ҳ': 'h', 'Ў': "O‘", 'ў': "o‘"
    };

    return result.split('').map(char => map[char] || char).join('');
}

// Экспортируем функции
module.exports = {
    transliterateToCyrillic,
    transliterateToLatin
};