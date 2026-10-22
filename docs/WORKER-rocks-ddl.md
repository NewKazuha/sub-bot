# مواصفة العامل: `rocks-ddl-proxy`

**الغرض:** تمكين `sub-bot` من قراءة قائمة ملفات الترجمة وتنزيلها من `ddl.rocks-team.net`،
الذي يحجب GitHub Actions.

**الحالة:** مواصفة مُتحقَّق من جدواها — لم يُنفَّذ العامل بعد.
**التاريخ:** 2026-10-22

---

## 1. المشكلة — مُقاسة

| الفحص | النتيجة |
|---|---|
| `curl` من جهاز منزلي | **HTTP 200 · 4,495 بايت** — لكنه **صفحة تحدي Cloudflare** |
| نفس الطلب من GitHub runner | **HTTP 403** |
| `href` في صفحة التحدي | 3 فقط — CSS/صورة. لا ملفات |
| `/api/resources/…` | **307** → SPA root. لا JSON API |

**المضيف تطبيق SPA خلف تحدي JS، لا مجرد حجب IP.**

---

## 2. الإثبات الحاسم — متصفح حقيقي ينجح

**شغّلت Chromium بلا واجهة على نفس الرابط:**

```
--headless=new --virtual-time-budget=20000 --dump-dom
```

**النتيجة:**
```
الحجم    : 72,705 بايت (الصفحة الحقيقية، لا التحدي)
العنوان  : Rocks-Team Index - /Bleach/ملفات الترجمة/
التحدي   : غير موجود ✅
الملفات  : 9 ملفات .rar مع الأحجام والتواريخ
```

**والملف المطلوب موجود بالاسم:**
```
[Rocks-Team] Bleach Sennen Kessen-hen - 49 [S4-09] [1080p].rar
```

**الخلاصة: التحدي **قابل للحل** بمتصفح. المشكلة في **العميل**، لا في الموقع.**

---

## 3. الحل: Cloudflare Worker + Browser Rendering

```
runner ──► worker ──► Chromium ──► ddl.rocks-team.net
                                     (يحلّ التحدي، يعيد DOM)
```

**يستخدم `@cloudflare/puppeteer` (Browser Rendering) لتشغيل Chromium حقيقي.**

---

## 4. عقد الـAPI — **HTML خام، لا JSON**

**قرار التصميم:** العامل يعيد **الـDOM بعد التنفيذ** كما هو.

**السبب:** محلّل البوت الحالي (`resolveSubtitleFromDirectory` في `site-scrapers.mjs:657`)
يستخدم `cheerio` ويقرأ `a[href]` بحثًا عن `.ass/.srt/.zip/.rar/.7z`.
**إرجاع HTML يعني صفر تغيير في المحلّل.**

### `GET /list?path=<encoded>`

**الخرج 200:** `Content-Type: text/html; charset=utf-8` + الـDOM المُنفَّذ.
**الخرج 502:** `{ "ok": false, "error": "challenge-not-solved" }`

### `GET /dl?u=<encoded>`

**الخرج 200:** بايتات الملف مع `Content-Disposition`.

---

## 5. الأمان — إلزامي

| البند | القاعدة |
|---|---|
| **SSRF** | مضيف واحد مسموح: `ddl.rocks-team.net`. ارفض أي شيء آخر. |
| **المصادقة** | `X-Proxy-Key` يطابق سرًّا في Worker → 401 بدونه. |
| **الحجم** | 64MB للملف · 2MB للـHTML. |
| **المهلة** | 30s للقائمة · 120s للتنزيل. |
| **التخزين** | `no-store`. |

---

## 6. التكامل مع البوت — **إعادة كتابة رابطين فقط**

### أ. القائمة — `telegram-client.mjs:2986`
```js
const listUrl = isRocksDdl(directUrl)
  ? `${WORKER}/list?path=${encodeURIComponent(pathOf(directUrl))}`
  : directUrl;
const resolved = await resolveSubtitleFromDirectory(listUrl, targetEp);
```
**`resolveSubtitleFromDirectory` لا تتغيّر** — ستقرأ HTML العامل بنفس الـcheerio.

### ب. التنزيل — `telegram-client.mjs:2995`
```js
const dlUrl = isRocksDdl(directUrl)
  ? `${WORKER}/dl?u=${encodeURIComponent(directUrl)}`
  : directUrl;
await downloadFileToDisk(dlUrl, tempDest, { Referer: postPageUrl });
```

**موضعان. لا أكثر.**

---

## 7. ما يبقى مجهولًا — بصراحة

**أُثبت:** متصفح حقيقي يقرأ الموقع من **IP منزلي**.

**لم يُثبت:** هل يقرأه Chromium من **شبكة Cloudflare** (حيث يعمل الـWorker)؟

**الاحتمالان:**
- Worker يمرّ → كل شيء يعمل.
- Worker يُحجب 403 (مثل الـrunner) → **الحل يصبح VPS بـFlareSolverr** (~5$/شهر)، وهو مضمون لأنه يعمل بـIP نظيف.

**اختبار قبل البناء:**
```
انشر worker بسيطًا يعيد req.cf.country + نتيجة fetch واحد للمضيف.
إن أعاد 200 → أكمل. إن أعاد 403 → توقّف واذهب للـVPS.
```

---

## 8. البدائل — مرتّبة

| # | البديل | التكلفة | الحالة |
|---|---|---|---|
| **1** | Worker + Browser Rendering | مجاني محدود | **مُرجَّح** — إثبات المتصفح نجح |
| 2 | VPS + FlareSolverr | ~5$/شهر | **مضمون** — IP نظيف |
| 3 | Chromium داخل الـrunner | صفر | ثقيل (300MB/جولة) لكنه **مُثبت** — نفس الاختبار نجح محليًا |
| 4 | قبول الخسارة | صفر | Rocks-Team يُتخطّى |

**البديل 3 مثير:** الـrunner نفسه يمكنه تشغيل Chromium. **الاختبار الذي أجريته هو بالضبط ما سيفعله.** التكلفة: وقت تحميل المتصفح كل جولة (~30 ثانية) — مقبول إن كانت الجولات 25 دقيقة.

**إن أردت أسرع حل بأقل مخاطرة: البديل 3.** **إن أردت أنظفه: البديل 1.**

---

## 9. معايير القبول

```
1. /list على مسار Bleach يعيد HTML فيه ".rar" واسم الحلقة 49
2. /dl ينزّل الملف، وحجمه مطابق للقائمة (3.30MB تقريبًا)
3. طلب بلا X-Proxy-Key → 401
4. u=https://evil.example → 403
5. جولة البوت الكاملة تنشر المنشور
6. لا انحدار: بقية المصادر تعمل كما هي
```

---

## 10. الحكم

**السؤال الحاسم أُجيب: نعم، متصفح حقيقي يقرأ الموقع.**

**فالمشكلة صارت هندسية لا استكشافية.** **والاختيار بين عامل وVPS يعتمد على اختبار واحد: هل يمرّ الـWorker؟**
