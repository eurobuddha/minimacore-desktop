package com.eurobuddha.nftwallet;
import java.nio.charset.StandardCharsets;
final class ImageTools {
    static final int ICON_BUDGET = 6000;
    public static String dataUri(String b64) {
        if (b64 == null || b64.isEmpty()) return "";
        return "data:" + mimeOf(b64) + ";base64," + b64;
    }

    public static String mimeOf(String b64) {
        try {
            int take = Math.min(b64.length(), 32);
            take -= take % 4;   // only decode a whole number of base64 quanta
            byte[] head = java.util.Base64.getMimeDecoder().decode(b64.substring(0, take));
            if (head.length >= 12 && head[0] == 'R' && head[1] == 'I' && head[2] == 'F' && head[3] == 'F'
                    && head[8] == 'W' && head[9] == 'E' && head[10] == 'B' && head[11] == 'P') {
                return "image/webp";
            }
            if (head.length >= 2 && (head[0] & 0xFF) == 0xFF && (head[1] & 0xFF) == 0xD8) return "image/jpeg";
            if (head.length >= 4 && (head[0] & 0xFF) == 0x89 && head[1] == 'P' && head[2] == 'N' && head[3] == 'G') {
                return "image/png";
            }
            String text = new String(head, StandardCharsets.UTF_8).trim().toLowerCase();
            if (text.startsWith("<svg") || text.startsWith("<?xml")) return "image/svg+xml";
        } catch (Throwable ignored) {}
        return "image/jpeg";
    }
}
