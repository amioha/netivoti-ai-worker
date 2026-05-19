import logger from './logger.js';

const CHUNK_SIZE    = parseInt(process.env.CHUNK_SIZE)    || 400; // מילים
const CHUNK_OVERLAP = parseInt(process.env.CHUNK_OVERLAP) || 50;  // מילים חפיפה

/* ============================================
   חלוקה לקטעים עם חפיפה
============================================ */
export function splitToChunks(pages, docMeta) {
  const chunks = [];
  let   chunkIndex = 0;

  for (const { page, text } of pages) {
    if (!text?.trim()) continue;

    const words    = text.split(/\s+/).filter(Boolean);
    const step     = CHUNK_SIZE - CHUNK_OVERLAP;

    for (let i = 0; i < words.length; i += step) {
      const sliceWords = words.slice(Math.max(0, i - CHUNK_OVERLAP), i + CHUNK_SIZE);
      const content    = sliceWords.join(' ').trim();

      if (content.length < 30) continue; // דלג על קטעים קצרים מדי

      chunks.push({
        document_id:  docMeta.id,
        doc_title:    docMeta.title,
        doc_url:      docMeta.file_url || '',
        content,
        page_num:     page,
        chunk_index:  chunkIndex++,
        metadata: {
          word_count:  sliceWords.length,
          year:        docMeta.year        || null,
          contractor:  docMeta.contractor  || null,
          doc_type:    docMeta.doc_type    || null,
          tender_num:  docMeta.tender_num  || null,
        },
      });
    }
  }

  logger.debug(`Created ${chunks.length} chunks from ${pages.length} pages`);
  return chunks;
}

/* ============================================
   חילוץ מטא-דאטה מהטקסט
   מזהה: שנה, קבלן, מכרז, סכומים, שכונה, סוג מסמך
============================================ */
export function extractMetadata(fullText) {
  const text = fullText || '';

  return {
    year:        extractYear(text),
    contractor:  extractContractor(text),
    tender_num:  extractTenderNum(text),
    amounts:     extractAmounts(text),
    neighborhood:extractNeighborhood(text),
    doc_type:    detectDocType(text),
  };
}

/* ---- שנה ---- */
function extractYear(text) {
  const matches = text.match(/\b(201\d|202\d)\b/g);
  if (!matches) return null;
  // החזר את השנה הנפוצה ביותר
  const counts = {};
  matches.forEach(y => { counts[y] = (counts[y] || 0) + 1; });
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

/* ---- קבלן ---- */
function extractContractor(text) {
  const patterns = [
    /חברת\s+([\u05d0-\u05ea\s"'״׳]+(?:בע"מ|בעמ|בע'מ)?)/,
    /קבלן[:\s]+([\u05d0-\u05ea\s"'״׳]+)/,
    /זוכה[:\s]+([\u05d0-\u05ea\s"'״׳]+(?:בע"מ|בעמ)?)/,
    /([\u05d0-\u05ea\s"'״׳]{3,20}\s+(?:בע"מ|בעמ|בע'מ))/,
  ];
  for (const pattern of patterns) {
    const m = text.match(pattern);
    if (m?.[1]) return m[1].trim().slice(0, 100);
  }
  return null;
}

/* ---- מספר מכרז ---- */
function extractTenderNum(text) {
  const m = text.match(/מכרז\s+(?:מס[׳'"]?\s*)?([0-9]{2,4}[\/\-][0-9]{2,6})/);
  return m?.[1] || null;
}

/* ---- סכומים כספיים ---- */
function extractAmounts(text) {
  const matches = text.match(/₪\s*([\d,]+(?:\.\d+)?)|(\d{1,3}(?:,\d{3})+)\s*(?:ש"ח|שקלים|ש׳)/g);
  if (!matches) return [];
  return [...new Set(matches)].slice(0, 10); // עד 10 סכומים ייחודיים
}

/* ---- שכונה ---- */
function extractNeighborhood(text) {
  const neighborhoods = [
    'אפרידר', 'מעלות הנחל', 'מעלה הנחל', 'נווה זיו', 'יד המייסדים',
    'מרכז העיר', 'אזור תעשייה', 'שכונה ד׳', 'שכונה ה׳',
  ];
  for (const n of neighborhoods) {
    if (text.includes(n)) return n;
  }
  return null;
}

/* ---- סוג מסמך ---- */
function detectDocType(text) {
  const types = [
    { type: 'tender',   keywords: ['מכרז', 'הצעת מחיר', 'זוכה במכרז', 'פרוטוקול פתיחת הצעות'] },
    { type: 'contract', keywords: ['חוזה', 'הסכם', 'התקשרות', 'התחייבות'] },
    { type: 'protocol', keywords: ['פרוטוקול', 'ישיבת מועצה', 'סדר יום', 'החלטות'] },
    { type: 'tabr',     keywords: ['תב"ר', 'תברים', 'תקציב בלתי רגיל'] },
    { type: 'invoice',  keywords: ['חשבונית', 'קבלה', 'תשלום', 'חשבון סופי'] },
    { type: 'audit',    keywords: ['ביקורת', 'מבקר', 'ממצאים', 'המלצות'] },
    { type: 'plan',     keywords: ['תכנית', 'תכנון', 'בינוי', 'היתר בניה', 'חוק התכנון'] },
    { type: 'budget',   keywords: ['תקציב', 'אומדן', 'הוצאות', 'הכנסות', 'מאזן'] },
    { type: 'foi',      keywords: ['חופש מידע', 'בקשה לקבלת מידע', 'ממונה על חופש המידע'] },
  ];

  const scores = {};
  for (const { type, keywords } of types) {
    scores[type] = keywords.filter(kw => text.includes(kw)).length;
  }

  const best = Object.entries(scores)
    .filter(([, score]) => score > 0)
    .sort((a, b) => b[1] - a[1])[0];

  return best?.[0] || 'other';
}
