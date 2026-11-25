package com.eurobuddha.nftwallet;

import java.io.*;
import java.nio.charset.StandardCharsets;
import org.json.*;

// Runs one Android engine tick. Only the Electron host can persist state or call its node.
public final class DesktopMint {
    static final BufferedReader input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
    static JSONObject call(String op, Object payload) {
        System.out.println(new JSONObject().put("op", op).put("payload", payload));
        try {
            String line = input.readLine();
            if (line == null) throw new EOFException();
            return new JSONObject(line);
        } catch (IOException e) { throw new IllegalStateException("Wallet host disconnected"); }
    }
    public static void main(String[] args) throws Exception {
        Context context = new Context(new JSONObject(input.readLine()));
        MintEngine.tick(context, new NodeApi(), message ->
            System.out.println(new JSONObject().put("op", "done").put("message", message)));
    }
}
final class Context {
    final JSONObject state;
    Context(JSONObject state) { this.state = state; }
    void save() {
        if (!DesktopMint.call("save", state).getBoolean("status"))
            throw new IllegalStateException("Could not persist mint progress");
    }
}
final class NodeApi {
    static final String ERR_TOO_LONG = "Node reply too large";
    interface Cb { void onResult(JSONObject json); void onError(String message); }
    void cmd(String command, Cb cb) { cb.onResult(DesktopMint.call("cmd", command)); }
}
final class LocalStore {
    static JSONArray load(Context c) { return c.state.getJSONArray("collections"); }
    static JSONObject pending(Context c) { return c.state.getJSONObject("pending"); }
    static void upsert(Context c, JSONObject row) {
        JSONArray rows = load(c);
        for (int i = 0; i < rows.length(); i++) {
            if (rows.getJSONObject(i).getLong("id") == row.getLong("id")) {
                rows.put(i, row); c.save(); return;
            }
        }
        throw new IllegalStateException("Unknown mint job");
    }
    static void setPending(Context c, String id, int tip) { pending(c).put(id, tip); c.save(); }
    static boolean pendingOk(Context c, String id, int tip) { return tip - pending(c).optInt(id, -100) >= 6; }
    static void prunePending(Context c, int tip) {
        if (pending(c).keySet().removeIf(id -> pendingOk(c,id,tip))) c.save();
    }
}
