package com.vidsave;

import org.telegram.telegrambots.meta.TelegramBotsApi;
import org.telegram.telegrambots.updatesreceivers.DefaultBotSession;

public class Main {
    public static void main(String[] args) {
        try {
            String token = System.getenv("BOT_TOKEN");
            if (token == null || token.isEmpty()) {
                token = "8266214493:AAGmFp3BCv1YWILatxnwFlEpMEXxz3kpuvk"; 
            }

            TelegramBotsApi botsApi = new TelegramBotsApi(DefaultBotSession.class);
            botsApi.registerBot(new VidSaveBot(token));
            System.out.println("🚀 Bot is running on Railway!");
        } catch (Exception e) {
            e.printStackTrace();
        }
    }
}
