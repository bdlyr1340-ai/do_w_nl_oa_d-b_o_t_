# Telegram Bot Simple

بوت بسيط جدًا، أغلب التحكم فيه من خلال `index.js`.

## الملفات
- `index.js` المنطق الرئيسي بالكامل تقريبًا
- `package.json` الحزم وأوامر التشغيل
- `.env.example` المتغيرات
- `Dockerfile` للنشر
- `railway.json` إعداد بسيط لـ Railway

## التشغيل المحلي
```bash
npm install
cp .env.example .env
npm start
```

## Railway
1. ارفع المشروع إلى GitHub
2. اربطه مع Railway
3. أضف المتغيرات من `.env.example`
4. Railway سيشغل `npm start`

## ملاحظات
- هذا البوت يعالج فقط الفيديوهات التي يرفعها المستخدم إلى تيليجرام.
- التحويل يتم عبر `ffmpeg`.
- قاعدة البيانات اختيارية، لكن عند وضع `DATABASE_URL` يتم حفظ المستخدمين والعمليات.
