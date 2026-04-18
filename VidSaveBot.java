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

import java.io.File;
import java.util.ArrayList;
import java.util.List;

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
        } else if (messageText.contains("instagram.com") || messageText.contains("tiktok.com")) {
            processDownload(chatId, messageText, "mp4");
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

        processDownload(chatId, url, format);
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

    private void processDownload(long chatId, String url, String format) {
        int waitMsgId = sendMessage(chatId, "جاري سحب الملف عبر سيرفراتنا... ⏳");

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
                    sendMessage(chatId, "❌ فشل التحميل، تأكد من الرابط أو خصوصية الحساب.");
                }
            } catch (Exception e) {
                sendMessage(chatId, "❌ حدث خطأ: " + e.getMessage());
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
