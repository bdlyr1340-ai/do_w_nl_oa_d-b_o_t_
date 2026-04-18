Railway + GitHub Deployment
===========================

1) Put these files in the root of your GitHub repository.
2) In Railway, create a new project from GitHub.
3) Railway will detect Dockerfile automatically and build from it.
4) Add your environment variables in Railway -> Variables.
5) Deploy.

Required variables
------------------
BOT_TOKEN           Telegram bot token from BotFather (use a NEW token)
BOT_RIGHTS          Text shown in bot captions, e.g. @VidSave_ProBot
TMP_DIR             Temporary downloads folder, recommended: ./downloads
MAX_FILE_SIZE_MB    Telegram upload safety limit; recommended 48
PORT                Railway port; recommended 3000
YTDLP_PATH          Path to yt-dlp inside Docker, recommended /usr/local/bin/yt-dlp

Optional variables
------------------
USE_WEBHOOK         true/false. false = long polling. true = webhook mode.
WEBHOOK_DOMAIN      Your public Railway domain if using webhook.
WEBHOOK_PATH        Webhook path, e.g. /telegram-webhook
COBALT_API_URL      Optional fallback downloader API compatible with Cobalt
COBALT_API_KEY      Optional API key for your Cobalt instance if protected
RAPIDAPI_KEY        Optional RapidAPI key for Instagram fallback API
RAPIDAPI_INSTAGRAM_HOST  RapidAPI host header for the Instagram API provider
IG_COOKIES_B64      Base64 of cookies.txt for authenticated Instagram extraction
IG_COOKIES_URL      Alternative: direct URL to a cookies.txt file
REQUEST_TIMEOUT_MS  Timeout per provider request; recommended 30000
PROVIDER_RETRY_COUNT Retry count per provider; recommended 1

Important notes
---------------
- Instagram Stories often need authentication or can hit rate limits.
- If stories fail, set IG_COOKIES_B64 or IG_COOKIES_URL.
- Do NOT put your token inside code.
- If your old token was exposed, revoke it in BotFather and generate a new one.
