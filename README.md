# שקיפות ציבורית נתיבות — Document Worker

Worker לעיבוד מסמכים אוטומטי. רץ כל 3 דקות, בודק Supabase, ומעבד מסמכים חדשים.

## Pipeline לכל מסמך

1. ✅ שליפת מסמכים בסטטוס `pending` מ-Supabase
2. ✅ הורדת הקובץ מ-URL
3. ✅ חילוץ טקסט (PDF ישיר / OCR עברית / Word / Excel)
4. ✅ חילוץ מטא-דאטה (שנה, קבלן, מכרז, סכומים)
5. ✅ חלוקה לקטעים עם חפיפה
6. ✅ יצירת Embeddings (Voyage AI)
7. ✅ שמירה ב-Supabase + עדכון סטטוס
8. ✅ לוג מסודר לכל שלב

---

## התקנה מהירה

### Railway (מומלץ)

1. לך ל-[railway.app](https://railway.app)
2. **New Project → Deploy from GitHub**
3. העלה את התיקייה לגיטהאב ובחר אותה
4. **Variables** — הוסף:
   ```
   ANTHROPIC_API_KEY = sk-ant-...
   SUPABASE_URL      = https://xxxx.supabase.co
   SUPABASE_KEY      = eyJ...
   ```
5. Railway יפעיל אוטומטית

### Render

1. לך ל-[render.com](https://render.com)
2. **New → Background Worker**
3. חבר גיטהאב → בחר את הריפו
4. הוסף Environment Variables (כמו למעלה)
5. לחץ **Deploy**

---

## משתני סביבה

| משתנה | חובה | ברירת מחדל | תיאור |
|-------|------|-----------|-------|
| `ANTHROPIC_API_KEY` | ✅ | — | Claude + Voyage API |
| `SUPABASE_URL` | ✅ | — | כתובת Supabase |
| `SUPABASE_KEY` | ✅ | — | Anon Key של Supabase |
| `BATCH_SIZE` | | `5` | מסמכים במקביל |
| `CRON_INTERVAL` | | `*/3 * * * *` | תדירות בדיקה |
| `MAX_RETRIES` | | `3` | ניסיונות חוזרים |
| `CHUNK_SIZE` | | `400` | מילים לקטע |
| `CHUNK_OVERLAP` | | `50` | חפיפה בין קטעים |
| `OCR_LANGUAGE` | | `heb+eng` | שפת OCR |
| `LOG_LEVEL` | | `info` | רמת לוג |

---

## לוגים

```
logs/worker.log  — כל הלוגים
logs/errors.log  — שגיאות בלבד
```

ב-Railway/Render הלוגים מוצגים בממשק הניהול.

---

## הרצה מקומית לבדיקה

```bash
cp .env.example .env
# ערוך .env עם המפתחות שלך

npm install
npm start
```
