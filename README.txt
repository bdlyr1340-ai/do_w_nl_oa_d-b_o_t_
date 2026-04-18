رفع المشروع إلى جذر مستودع GitHub ثم اربطه مع Railway.

المهم:
1) غيّر التوكن القديم من BotFather فورًا.
2) أضف Variables في Railway من .env.example.
3) إذا كان Instagram يفشل في بعض الروابط أو القصص، ففعّل واحدًا على الأقل من هذه الخيارات:
   - IG_COOKIES_B64
   - COBALT_API_URL
   - RAPIDAPI_KEY

شرح المتغيرات:
- BOT_TOKEN: توكن البوت.
- BOT_RIGHTS: يظهر في الرسائل.
- TMP_DIR: مجلد مؤقت للملفات.
- MAX_FILE_SIZE_MB: أقصى حجم إرسال إلى تيليجرام.
- PORT: منفذ الخدمة.
- USE_WEBHOOK: true أو false.
- WEBHOOK_DOMAIN: دومين الويب هوك إن استخدمته.
- WEBHOOK_PATH: مسار الويب هوك.
- YTDLP_PATH: مسار yt-dlp.
- FFMPEG_PATH: مسار ffmpeg.
- REQUEST_TIMEOUT_MS: مهلة طلبات الشبكة.
- PROVIDER_RETRY_COUNT: عدد محاولات الإعادة لكل مزود.
- COBALT_API_URL: رابط API احتياطي يدعم Instagram/TikTok.
- COBALT_API_KEY: إن كانت نسخة Cobalt تتطلب مفتاحًا.
- RAPIDAPI_KEY: مفتاح RapidAPI الاحتياطي لـ Instagram.
- RAPIDAPI_INSTAGRAM_HOST: اسم مضيف RapidAPI.
- IG_COOKIES_B64: أقوى حل لإنستغرام، وهو محتوى cookies.txt بصيغة base64.

تحويل cookies.txt إلى base64:
Linux/macOS:
base64 -w 0 cookies.txt

Windows PowerShell:
[Convert]::ToBase64String([IO.File]::ReadAllBytes("cookies.txt"))

ملاحظة مهمة:
بعض روابط Instagram العامة قد تتطلب login أو تصطدم بـ rate limit. هذا ليس خطأ في Node نفسه. لذلك هذا المشروع يجرب:
RapidAPI -> Cobalt -> yt-dlp with cookies -> yt-dlp بدون cookies
