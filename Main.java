package com.vidsave;

import org.telegram.telegrambots.bots.TelegramLongPollingBot;
import org.telegram.telegrambots.meta.api.methods.send.SendAudio;
import org.telegram.telegrambots.meta.api.methods.send.SendMessage;
import org.telegram.telegrambots.meta.api.methods.send.SendVideo;
import org.telegram.telegrambots.meta.api.methods.updatingmessages.DeleteMessage;
import org.telegram.telegrambots.meta.api.objects.InputFile;
import org.telegram.telegrambots.meta.api.objects.Update;
import org.telegram.telegrambots.meta.api.objects.replykeyboard.InlineKeyboardMarkup;
import org.telegram.telegrambots.meta.api.objects.replykeyboard.buttons.InlineKeyboardButton;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;

import org.json.JSONArray;
import org.json.JSONObject;

public class VidSaveBot extends TelegramLongPollingBot {

    private final String botToken;
    private final String BOT_RIGHTS = "@VidSave_ProBot";

    public VidSaveBot(String botToken) {
        this.botToken = botToken;
    }

    @Override
    public String getBotUsername() {
        return "VidSave_ProBot";
    }

    @Override
    public String getBotToken() {
        return botToken;
    }

    @Override
    public void onUpdateReceived(Update update) {
        if (update.hasMessage() && update.getMessage().hasText()) {
            handleIncomingMessage(update);
        } else if (update.hasCallbackQuery()) {
            handleCallbackQuery(update);
        }
    }

    private void handleIncomingMessage(Update update) {
        String messageText = update.getMessage().getText();
        long chatId = update.getMessage().getChatId();

        if (messageText.equals("/start")) {
            sendMessage(chatId, "أهلاً بك في بوت التحميل الذكي 🚀\n- أرسل رابط انستغرام أو تيك توك للتحميل المباشر.\n- أرسل رابط يوتيوب للاختيار بين (صوت أو فيديو).");
        } else if (messageText.contains("youtube.com") || messageText.contains("youtu.be")) {
            sendYouTubeButtons(chatId, messageText);
        } else if (messageText.contains("instagram.com")) {
            processInstagram(chatId, messageText);
        } else if (messageText.contains("tiktok.com")) {
            processTikTok(chatId, messageText);
        } else {
            sendMessage(chatId, "❌ هذا الرابط غير مدعوم.");
        }
    }

    private void handleCallbackQuery(Update update) {
        String callData = update.getCallbackQuery().getData();
        long chatId = update.getCallbackQuery().getMessage().getChatId();
        int messageId = update.getCallbackQuery().getMessage().getMessageId();

        deleteMessage(chatId, messageId);

        String[] parts = callData.split("\\|");
        if (parts.length < 2) return;
        String format = parts[0];
        String url = parts[1];

        processYtDlpDownload(chatId, url, format);
    }

    private void sendYouTubeButtons(long chatId, String url) {
        SendMessage message = new SendMessage();
        message.setChatId(chatId);
        message.setText("لقد أرسلت رابط يوتيوب، اختر الصيغة المطلوبة:");

        InlineKeyboardMarkup markupInline = new InlineKeyboardMarkup();
        List<List<InlineKeyboardButton>> rowsInline = new ArrayList<>();
        List<InlineKeyboardButton> rowInline = new ArrayList<>();

        InlineKeyboardButton btnMp3 = new InlineKeyboardButton();
        btnMp3.setText("تحميل صوت (MP3) 🎵");
        btnMp3.setCallbackData("mp3|" + url);

        InlineKeyboardButton btnMp4 = new InlineKeyboardButton();
        btnMp4.setText("تحميل فيديو (MP4) 🎬");
        btnMp4.setCallbackData("mp4|" + url);

        rowInline.add(btnMp3);
        rowInline.add(btnMp4);
        rowsInline.add(rowInline);
        markupInline.setKeyboard(rowsInline);
        message.setReplyMarkup(markupInline);

        try {
            execute(message);
        } catch (Exception e) {
            e.printStackTrace();
        }
    }

    // --- يوتيوب (يبقى على yt-dlp لأنه الأفضل والأقوى ليوتيوب) ---
    private void processYtDlpDownload(long chatId, String url, String format) {
        int waitMsgId = sendMessage(chatId, "جاري سحب الملف... ⏳");

        new Thread(() -> {
            try {
                String fileName = "media_" + System.currentTimeMillis() + (format.equals("mp3") ? ".m4a" : ".mp4");
                String dlFormat = format.equals("mp3") ? "bestaudio[ext=m4a]" : "best[ext=mp4]";

                ProcessBuilder pb = new ProcessBuilder("yt-dlp", "-f", dlFormat, "-o", fileName, "--quiet", "--no-playlist", url);
                Process p = pb.start();
                p.waitFor();

                File file = new File(fileName);
                if (file.exists()) {
                    if (format.equals("mp3")) {
                        SendAudio sendAudio = new SendAudio();
                        sendAudio.setChatId(chatId);
                        sendAudio.setAudio(new InputFile(file));
                        sendAudio.setCaption("✅ تم تحميل الصوت بواسطة: " + BOT_RIGHTS);
                        execute(sendAudio);
                    } else {
                        SendVideo sendVideo = new SendVideo();
                        sendVideo.setChatId(chatId);
                        sendVideo.setVideo(new InputFile(file));
                        sendVideo.setCaption("✅ تم تحميل الفيديو بواسطة: " + BOT_RIGHTS);
                        execute(sendVideo);
                    }
                    file.delete();
                } else {
                    sendMessage(chatId, "❌ فشل التحميل من يوتيوب.");
                }
            } catch (Exception e) {
                sendMessage(chatId, "❌ حدث خطأ: " + e.getMessage());
            } finally {
                deleteMessage(chatId, waitMsgId);
            }
        }).start();
    }

    // --- إنستغرام (يستخدم API خاص لتجاوز حظر السيرفرات) ---
    private void processInstagram(long chatId, String url) {
        int waitMsgId = sendMessage(chatId, "جاري سحب فيديو إنستغرام... ⏳");
        new Thread(() -> {
            try {
                URL obj = new URL("https://api.siputzx.my.id/api/d/igdl?url=" + url);
                HttpURLConnection con = (HttpURLConnection) obj.openConnection();
                con.setRequestMethod("GET");
                con.setRequestProperty("User-Agent", "Mozilla/5.0");

                BufferedReader in = new BufferedReader(new InputStreamReader(con.getInputStream()));
                StringBuilder response = new StringBuilder();
                String inputLine;
                while ((inputLine = in.readLine()) != null) response.append(inputLine);
                in.close();

                JSONObject json = new JSONObject(response.toString());
                boolean success = false;

                if (json.has("data")) {
                    JSONArray data = json.getJSONArray("data");
                    if (data.length() > 0) {
                        String videoUrl = data.getJSONObject(0).getString("url");
                        SendVideo sendVideo = new SendVideo();
                        sendVideo.setChatId(chatId);
                        sendVideo.setVideo(new InputFile(videoUrl));
                        sendVideo.setCaption("✅ تم التحميل بواسطة: " + BOT_RIGHTS);
                        execute(sendVideo);
                        success = true;
                    }
                }
                if (!success) sendMessage(chatId, "❌ الحساب خاص أو الرابط غير صحيح.");

            } catch (Exception e) {
                sendMessage(chatId, "❌ حدث خطأ في السيرفر: " + e.getMessage());
            } finally {
                deleteMessage(chatId, waitMsgId);
            }
        }).start();
    }

    // --- تيك توك (يستخدم API خاص وسريع جداً) ---
    private void processTikTok(long chatId, String url) {
        int waitMsgId = sendMessage(chatId, "جاري سحب فيديو تيك توك... ⚡");
        new Thread(() -> {
            try {
                URL obj = new URL("https://www.tikwm.com/api/");
                HttpURLConnection con = (HttpURLConnection) obj.openConnection();
                con.setRequestMethod("POST");
                con.setRequestProperty("User-Agent", "Mozilla/5.0");
                con.setDoOutput(true);
                con.getOutputStream().write(("url=" + url).getBytes());

                BufferedReader in = new BufferedReader(new InputStreamReader(con.getInputStream()));
                StringBuilder response = new StringBuilder();
                String inputLine;
                while ((inputLine = in.readLine()) != null) response.append(inputLine);
                in.close();

                JSONObject json = new JSONObject(response.toString());
                if (json.getInt("code") == 0) {
                    String videoUrl = json.getJSONObject("data").getString("play");
                    SendVideo sendVideo = new SendVideo();
                    sendVideo.setChatId(chatId);
                    sendVideo.setVideo(new InputFile(videoUrl));
                    sendVideo.setCaption("✅ تم التحميل بواسطة: " + BOT_RIGHTS);
                    execute(sendVideo);
                } else {
                    sendMessage(chatId, "❌ فشل تحميل التيك توك.");
                }
            } catch (Exception e) {
                sendMessage(chatId, "❌ حدث خطأ في السيرفر: " + e.getMessage());
            } finally {
                deleteMessage(chatId, waitMsgId);
            }
        }).start();
    }

    private int sendMessage(long chatId, String text) {
        SendMessage msg = new SendMessage();
        msg.setChatId(chatId);
        msg.setText(text);
        try {
            return execute(msg).getMessageId();
        } catch (Exception e) {
            return 0;
        }
    }

    private void deleteMessage(long chatId, int messageId) {
        DeleteMessage deleteMessage = new DeleteMessage(String.valueOf(chatId), messageId);
        try {
            execute(deleteMessage);
        } catch (Exception ignored) {}
    }
}
