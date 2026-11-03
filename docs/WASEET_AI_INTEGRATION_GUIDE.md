# 📘 دليل التكامل والتسليم البرمجي لخدمة WaseetAI (Developer Handoff Guide)

خدمة **WaseetAI** هي مايكروسيرفيس مستقلة مبنية بـ Node.js + TypeScript (Fastify + Zod + ESM) لتقديم كافة قدرات الذكاء الاصطناعي لمنصة **وسيط (Waseet Freelance Platform)** وفقاً لمواصفات وثيقتي `AI.pdf` و `AI2.pdf`. تعمل الخدمة عبر معمارية سحابية موزعة وعالية التوافر (High-Availability Cloud Architecture) لإدارة الأحمال وتجاوز الفشل تلقائياً مع ضمان استمرارية 99.9%.

---

## 🏛️ 1. المعمارية ونظام التوثيق (Architecture & Auth)

```mermaid
flowchart LR
    Platform[Waseet Platform Backend / Web Client] -->|Bearer Token / Socket.IO| Gateway[WaseetAI Gateway]
    Gateway --> Classifier{Data Privacy Classifier}
    Classifier -->|High Security / Dispute / Financial| SecureCluster[Waseet Secure Core Cluster]
    Classifier -->|Public / Synthetic / Draft| FastCluster[Waseet Distributed Fast Cluster]
    SecureCluster --> Router[Intelligent Cooldown Router]
    FastCluster --> Router
    Router --> Engine[Waseet Neural LLM & Voice Engine]
```

### بيانات الاعتماد (Credentials)
- **Base URL:** `http://localhost:3000` (أو رابط Cloud Run في الإنتاج)
- **Header:** `Authorization: Bearer <SIGNED_ACCESS_TOKEN>`
- **Client ID Header:** `X-Client-Id: <WASEET_AI_CLIENT_ID>`
- **Request ID Header:** `X-Request-Id: <UUID>`

### الحصول على توكن التحقق (REST)
تتم هذه الخطوة بين الخوادم فقط. كلمة سر العميل ليست توكن Bearer ولا تُرسل للمتصفح.

```http
POST /v1/auth/token
Content-Type: application/json

{
  "clientId": "<SERVER_CLIENT_ID>",
  "clientSecret": "<SERVER_CLIENT_SECRET>",
  "environment": "dev",
  "actor": { "userId": "<AUTHENTICATED_USER_ID>", "role": "provider" }
}
```

استخدم `token` من الرد كترويسة Bearer. صلاحيته 900 ثانية ومربوط بهوية المستخدم والعميل والبيئة. يحدد باك المنصة `actor` من الجلسة الحقيقية؛ لا يثق بهوية يختارها المتصفح. الرموز الثابتة والرموز القديمة مرفوضة في كل البيئات. يجب تطابق بيانات العميل والبيئة بين الخدمتين.

باك المنصة يدعم التبادل عبر `WASEET_AI_AUTH_MODE=signed` مع `WASEET_AI_CLIENT_SECRET` و`WASEET_AI_CLIENT_ID` و`WASEET_AI_ENVIRONMENT` الصحيحة. وجود الكود لا يثبت إعداد النسخة المنشورة؛ راجع الإعدادات بشكل آمن قبل تطبيق الإصلاح.

---

## 🔀 2. حوض المشاريع المتعدد وتوجيه البيانات (Multi-Project Pool & Router)

1. **حوض المشاريع (Project Pool):**
   - **المشروع المدفوع:** `projects/1041761245251` (مخصص لكافة البيانات الحساسة والشخصية وعقود النزاعات).
   - **8 مشاريع مجانية مستقلة:** مخصصة للمهام العامة وتوليد الأوصاف والأسئلة والاختبارات التمهيدية.
2. **سياسة حماية الخصوصية (Privacy Enforcement):**
   - البيانات المصنفة كـ `SENSITIVE` أو `PERSONAL` أو `INTERNAL` لا تمرر نهائياً للمشاريع المجانية، بل تُوجّه حصراً للمشروع المدفوع.
3. **التبديل التلقائي وفترة التهدئة (429/503 Cooldown & Failover):**
   - عند مواجهة خطأ `429 Too Many Requests` أو `503 Service Unavailable` من أي مشروع، يتم تفعيل فترة تهدئة تصاعدية (`Exponential Backoff`).
   - يقوم الراوتر فوراً بالتحويل إلى مشروع آخر متاح **على نفس الموديل** بدون تأخير عبر سعة محاولات تصل إلى 16 محاولة لتغطية كامل الحوض.
   - في حال نفاد كافة المشاريع لنفس الموديل، ينحدر الراوتر تلقائياً للموديل البديل (`Tiered Model Degradation: HEAVY -> MEDIUM -> NORMAL -> LIGHT`).

---

## 📊 3. جدول مطابقة المسارات الـ 31 (All 31 Features Matrix)

تدعم خدمة WaseetAI كلاً من واجهات `/v1/...` الحديثة وواجهات `/api/...` القديمة لضمان التوافق العكسي بنسبة 100%:

| # | المعرف الوظيفي | المسار الحديث (Modern V1) | المسار التوافقي (Legacy API) | تصنيف الخصوصية | ربط Socket.IO |
|---|---|---|---|---|---|
| 1 | AI-01 | `POST /v1/ai/project-description/stream` | `POST /api/project/description/stream` | PUBLIC_APPROVED | `ai:generate_description` |
| 2 | AI-02 | `POST /v1/ai/request-draft` | `POST /api/request/draft/suggest` | PUBLIC_APPROVED | - |
| 3 | AI-03 | `POST /v1/ai/milestones` | `POST /api/project/milestones/suggest` | PUBLIC_APPROVED | - |
| 4 | AI-04 | `POST /v1/ai/project-analysis` | `POST /api/project/plan/analyze` | PUBLIC_APPROVED | - |
| 5 | AI-05 | `POST /v1/ai/text/suggest/stream` | `POST /api/text/suggest/stream` | PUBLIC_APPROVED | `stream_ai_suggest_text` |
| 6 | AI-06 | `POST /v1/ai/portfolio-review` | `POST /api/provider/portfolio/review` | PUBLIC_APPROVED | - |
| 7 | AI-07 | `POST /v1/ai/accreditation-review` | `POST /api/provider/accreditation/submit` | PUBLIC_APPROVED | - |
| 8 | AI-08 | `POST /v1/ai/assessments` | `POST /api/provider/assessments/start` | PUBLIC_APPROVED | `start_assessment` |
| 9 | AI-09 | `POST /v1/ai/onboarding-quizzes` | `POST /api/onboarding/quiz/init` | PUBLIC_APPROVED | `setup_test:init` |
| 10 | AI-10 | `POST /v1/ai/proposals/suggest` | `POST /api/proposals/suggest` | PUBLIC_APPROVED | - |
| 11 | AI-11 | `POST /v1/ai/proposals/audit/stream` | `POST /api/proposals/audit/stream` | PUBLIC_APPROVED | `trigger_ai_audit` |
| 12 | AI-12 | `POST /v1/ai/proposals/enrich` | `POST /api/proposals/submit-enriched` | SENSITIVE (Paid) | - |
| 13 | AI-13 | `POST /v1/ai/matching/projects-for-provider` | `POST /api/matching/projects-for-provider` | PUBLIC_APPROVED | - |
| 14 | AI-14 | `POST /v1/ai/project-fit` | `POST /api/matching/project-fit` | PUBLIC_APPROVED | - |
| 15 | AI-15 | `POST /v1/ai/marketplace/recommendations` | `POST /api/marketplace/recommendations` | PUBLIC_APPROVED | - |
| 16 | AI-16 | `POST /v1/ai/profile/performance-summary` | `POST /api/provider/public-profile/metrics` | PUBLIC_APPROVED | - |
| 17 | AI-17 | `POST /v1/ai/profile/bio` & `/skills` | `POST /api/provider/profile/bio-suggestions` | PUBLIC_APPROVED | - |
| 18 | AI-18 | `POST /v1/ai/project-health` | `POST /api/project/health-review` | SENSITIVE (Paid) | - |
| 19 | AI-19 | `POST /v1/ai/delivery-review` (client) | `POST /api/client/delivery/review` | SENSITIVE (Paid) | - |
| 20 | AI-20 | `POST /v1/ai/disputes/summary` | `POST /api/disputes/summary` | SENSITIVE (Paid) | - |
| 21 | AI-21 | `POST /v1/ai/help/stream` | `POST /api/help/stream` | PUBLIC_APPROVED | `help:ask` |
| 22 | AI2-01 | `POST /v1/ai/business-models/re-audit` | `POST /api/business-model/re-audit` | PUBLIC_APPROVED | - |
| 23 | AI2-02 | `POST /v1/ai/business-models/audit` | `POST /api/business-model/audit` | PUBLIC_APPROVED | - |
| 24 | AI2-03 | `POST /v1/ai/delivery-review` (provider) | `POST /api/provider/delivery/review` | SENSITIVE (Paid) | - |
| 25 | AI2-04 | `POST /v1/ai/avatar/chat` | `POST /api/avatar/chat` | PUBLIC_APPROVED | `ai_chat` |
| 26 | AI2-05 | `POST /v1/ai/assessments/:id/submit` | `POST /api/provider/assessments/submit` | PUBLIC_APPROVED | `submit_answer` |
| 27 | AI2-06 | `GET /v1/ai/assessments/:id/status` | `GET /api/provider/assessments/status` | PUBLIC_APPROVED | - |
| 28 | AI2-07 | `POST /v1/ai/assessments/stream` | `POST /api/provider/assessments/stream` | PUBLIC_APPROVED | `question_streamed` |
| 29 | AI2-08 | `POST /v1/ai/proposals/audit/stream` | `POST /api/proposals/audit/stream` | PUBLIC_APPROVED | `trigger_ai_audit` |
| 30 | AI2-09 | `POST /v1/ai/text/suggest/stream` | `POST /api/text/suggest/stream` | PUBLIC_APPROVED | `stream_ai_suggest_text` |
| 31 | AI2-10 | `POST /v1/ai/text/enhance/stream` | `POST /api/text/enhance/stream` | PUBLIC_APPROVED | `stream_ai_enhance_description` |

---

## 🛡️ 4. لقطات السياق والتحقق الأمني (Context Snapshots & Security)

تعتمد الخدمة فحصاً أمنياً صارماً عبر `ContextValidator` للتحقق من لقطات السياق المشفرة وغير القابلة للتلاعب:

### 1. لقطة سياق المشروع (`ProjectContextSnapshot`)
```json
{
  "entityId": "proj-101",
  "entityType": "project",
  "sourceVersion": 1,
  "asOf": "2026-09-29T10:00:00.000Z",
  "locale": "ar",
  "currency": "USD",
  "title": "تطوير تطبيق جوال متقدم",
  "description": "نظام متعدد المنصات Flutter مع واجهة تحكم Node.js",
  "budget": 5000,
  "deadlineDays": 30,
  "milestones": [
    { "title": "مرحلة 1", "description": "واجهات المستخدم", "amount": 2000, "percentage": 40, "days": 10 }
  ]
}
```

### 2. لقطة سياق التسليم (`DeliveryContextSnapshot`)
```json
{
  "entityId": "del-202",
  "entityType": "delivery",
  "projectId": "proj-101",
  "stageId": "stage-1",
  "providerId": "prov-55",
  "clientId": "client-99",
  "scopeAgreed": "بناء واجهات الدخول والملف الشخصي",
  "submissionDetails": "تم رفع الكود بالكامل وتوثيق الـ APIs",
  "submittedFiles": ["https://github.com/org/repo/pull/4"]
}
```

### 3. لقطة سياق النزاع (`DisputeContextSnapshot`)
```json
{
  "entityId": "disp-303",
  "entityType": "dispute",
  "disputeId": "disp-303",
  "projectId": "proj-101",
  "clientId": "client-99",
  "providerId": "prov-55",
  "clientClaim": "التسليم غير مكتمل وتوجد أخطاء في واجهة التطبيق",
  "providerClaim": "تم تسليم المتطلبات بالكامل وفق مواصفات العقد المتفق عليها",
  "agreedMilestones": ["المرحلة الأولى: واجهات المستخدم"],
  "timelineEvents": [
    { "timestamp": "2026-09-15T08:00:00.000Z", "event": "بدء المرحلة وتأكيد النطاق" }
  ]
}
```

---

## ⚡ 5. جسر Socket.IO للتكامل الحي (Real-time Socket.IO Bridge)

تدعم الخدمة خادم Socket.IO مدمج ومتصل مباشرة بمحرك Fastify الأساسي:

### كود الربط من الواجهة الأمامية (Frontend JavaScript / TypeScript):
```typescript
import { io } from "socket.io-client";

const socket = io("http://localhost:3000", {
  query: { userId: "user-12345" },
  transports: ["websocket", "polling"],
});

// 1. توليد وصف المشروع بالبث الحي
socket.emit("ai:generate_description", { title: "منصة توصيل طلبات" });
socket.on("ai:description_chunk", (data) => console.log("Chunk:", data.chunk));
socket.on("ai:description_complete", () => console.log("الوصف اكتمل!"));

// 2. اختبار التهيئة والإعداد (Onboarding Quiz)
socket.emit("setup_test:init");
socket.on("setup_test:ready", (data) => console.log("الأسئلة:", data.questions));

// 3. المحادثة الصوتية مع الأفاتار
socket.emit("ai_chat", { message: "كيف أنشئ مشروعاً جديداً؟" });
socket.on("ai_chat_response", (data) => {
  console.log("Text:", data.text);
  console.log("Base64 Audio:", data.audio);
});
```

---

## 🎙️ 6. خدمة النطق الصوتي وتوليد اللهجات (Waseet Neural Voice)

تعتمد خدمة WaseetAI أحدث محركات النطق الصوتي الذكي **Waseet Voice Pro** و **Waseet Voice Turbo** و **Waseet Voice Lite** لتحويل النصوص المكتوبة إلى نطق بشري عالي الجودة والواقعية مع التحكم الكامل في اللهجات العربية والسرعة ونبرة الصوت:

### 1. توليد النطق الصوتي (Unary Synthesis)
* **المسار:** `POST /v1/ai/tts/synthesize`
* **الترويسات:**
  * `Authorization: Bearer <SERVER_CLIENT_SECRET>`
  * `Content-Type: application/json`

**بيانات الطلب (Request Payload):**
```json
{
  "text": "يا أهلاً بيك يا فندم في منصة وسيط! إحنا هنا علشان نضمنلك كل مليم في مشروعك ونسلملك الشغل على الفرازة.",
  "model": "AUTO",
  "voice": "Puck",
  "dialect": "egyptian",
  "speakingRate": "normal",
  "mimeType": "audio/wav"
}
```

**خيارات المحركات الصوتية (Models):**
* `AUTO`: الاختيار والتوجيه الذكي التلقائي لتحقيق أعلى سرعة واستقرار.
* `waseet-voice-pro`: جودة استوديو صوتية فائقة ونبرة طبيعية دقيقة.
* `waseet-voice-turbo`: متوازن فائق السرعة ومناسب للتطبيقات التفاعلية.
* `waseet-voice-lite`: خفيف وسريع الاستجابة.

**خيارات اللهجات (Dialects):**
* `egyptian`: اللهجة المصرية (عامية مصرية دافئة ومحفزة).
* `gulf`: اللهجة الخليجية (هادئة ومهذبة ومرحابة).
* `saudi`: اللهجة السعودية (مرحابة وواثقة).
* `msa`: اللغة العربية الفصحى المعاصرة (واضحة ورسمية).
* `english`: الإنجليزية الاحترافية (Professional English).

**أصوات الاستوديو المتاحة (Voices):**
* `Puck`: ذكر - حيوي، مرح وودود (ممتاز للعربية).
* `Kore`: أنثى - واثقة، قوية ورسمية.
* `Fenrir`: ذكر - حماسي وطاقة عالية.
* `Aoede`: أنثى - سلسة وهادئة.
* `Zephyr`: أنثى - مشرقة ونقية.
* `Sulafat`: أنثى - دافئة وودودة.
* `Charon`: ذكر - رصين ومعلوماتي.

**استجابة الخادم (Response):**
```json
{
  "success": true,
  "requestId": "req-1790695400147",
  "data": {
    "audio": {
      "mimeType": "audio/wav",
      "base64Audio": "UklGRqp5BwBXQVZFZm10IBAAAAABAAEAwF0...",
      "sizeBytes": 478386,
      "durationEstimateSec": 5.0
    },
    "metadata": {
      "voice": "Puck",
      "dialect": "egyptian",
      "style": "Egyptian Arabic dialect (لهجة مصرية عامية), warm, natural, friendly, lively and expressive",
      "modelUsed": "waseet-voice-pro",
      "projectAliasUsed": "waseet-cloud-primary",
      "mimeType": "audio/wav",
      "sizeBytes": 478386,
      "durationEstimateSec": 5.0
    }
  }
}
```

### 2. البث الحي المباشر للصوت عبر الرابط (Direct Audio URL)
* **المسار:** `GET /v1/ai/tts/speak?text=...&voice=Puck&dialect=egyptian&model=AUTO`
* يقوم بإرجاع تدفق صوتي ثنائي مباشر (`audio/wav`) يمكن تشغيله مباشرة في عنصر `<audio>` بالمتصفح أو تطبيقات الموبايل:
```html
<audio src="https://waseet-ai-api-1041761245251.us-central1.run.app/v1/ai/tts/speak?text=مرحبا+بكم+في+وسيط&dialect=egyptian" controls autoplay></audio>
```

### 3. تدفق الصوت الحي بتقنية SSE (Streaming Speech)
* **المسار:** `POST /v1/ai/tts/stream`
* يبث أجزاء الصوت فور توليدها تدفقياً عبر أحداث `event: chunk` المشفرة بصيغة Base64 مع إشعار انتهاء `event: done`.

