import com.eurobuddha.wallet.TxnFactory;
import com.eurobuddha.wallet.WalletCore;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import org.minima.database.userprefs.txndb.TxnRow;
import org.minima.objects.Coin;
import org.minima.objects.CoinProof;
import org.minima.objects.ScriptProof;
import org.minima.objects.base.MiniData;
import org.minima.objects.base.MiniNumber;
import org.minima.utils.json.JSONArray;
import org.minima.utils.json.JSONObject;
import org.minima.utils.json.parser.JSONParser;

/** One request on stdin. No node, database, network, command-line secrets or saved seed. */
public final class ClassicWebWallet {
    static JSONObject handle(JSONObject request) throws Exception {
        // Classic genkey parsed a quoted phrase first (including its historical colon spacing).
        // Parse only. Never execute a command or open a node wallet.
        String phrase = org.minima.system.commands.CommandRunner.getRunner()
                .getCommand("keys action:genkey phrase:\"" + request.getString("seed") + "\"").getParam("phrase");
        boolean[] consumed = { false };
        WalletCore wallet = new WalletCore(phrase, index -> {
            int leaf = Integer.parseInt(request.getString("leaf"));
            if (index != 0 || leaf < 0 || leaf >= 262144 || consumed[0])
                throw new IllegalArgumentException("Invalid leaf reservation");
            consumed[0] = true;
            return leaf;
        });
        JSONObject result = new JSONObject();
        if ("derive".equals(request.get("action"))) {
            result.put("publickey", wallet.getPublicKey(0).to0xString());
            result.put("script", wallet.getScript(0));
            result.put("address", wallet.getReceiveAddress().getAddressData().to0xString());
            result.put("miniaddress", wallet.getReceiveAddress().getMinimaAddress());
            return result;
        }
        if (!"sign".equals(request.get("action"))) throw new IllegalArgumentException("Unknown operation");
        MiniData token = new MiniData(request.getString("tokenid"));
        MiniNumber display = new MiniNumber(request.getString("amount"));
        JSONArray exports = (JSONArray) request.get("proofs");
        if (exports.isEmpty()) throw new IllegalArgumentException("Missing inputs");
        ArrayList<TxnFactory.InputCoin> inputs = new ArrayList<>();
        ArrayList<CoinProof> proofs = new ArrayList<>();
        HashSet<String> ids = new HashSet<>();
        for (Object item : exports) {
            JSONObject entry = (JSONObject) item;
            CoinProof proof = CoinProof.convertMiniDataVersion(new MiniData(entry.getString("data")));
            Coin coin = proof.getCoin();
            if (coin.getSpent() || !coin.getCoinID().to0xString().equalsIgnoreCase(entry.getString("coinid"))
                    || !ids.add(coin.getCoinID().to0xString()) || !coin.getTokenID().isEqual(token)
                    || !coin.getAddress().isEqual(wallet.getReceiveAddress().getAddressData()))
                throw new IllegalArgumentException("Coin does not match payment");
            inputs.add(TxnFactory.fromExportedCoin(coin, 0));
            proofs.add(proof);
        }
        MiniNumber raw = display;
        if (!token.isEqual(TxnFactory.TOKEN_MINIMA)) {
            org.minima.objects.Token descriptor = inputs.get(0).getToken();
            raw = descriptor.getScaledMinimaAmount(display);
            if (!descriptor.getScaledTokenAmount(raw).isEqual(display))
                throw new IllegalArgumentException("Unrepresentable token amount");
        }
        if (!raw.isValidMinimaValue()) throw new IllegalArgumentException("Invalid raw coin amount");
        String id = request.getString("id");
        TxnFactory.BuiltTxn built = new TxnFactory(wallet).buildSend(inputs, request.getString("to"),
                raw, token, MiniNumber.ZERO, id);
        for (CoinProof proof : proofs) built.getWitness().addCoinProof(proof);
        built.getWitness().addScript(new ScriptProof(wallet.getScript(0)));
        TxnRow row = new TxnRow(id, built.getTransaction(), built.getWitness());
        result.put("data", MiniData.getMiniDataVersion(row).to0xString());
        return result;
    }

    public static void main(String[] args) {
        try {
            JSONObject request = (JSONObject) new JSONParser().parse(new InputStreamReader(System.in, StandardCharsets.UTF_8));
            java.io.PrintStream response = System.out;
            System.setOut(new java.io.PrintStream(java.io.OutputStream.nullOutputStream()));
            response.print(handle(request).toString());
        } catch (Exception failure) {
            // Parser and crypto errors can contain their input. Never echo them to the host.
            System.exit(1);
        }
    }
}
