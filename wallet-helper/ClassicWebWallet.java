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
        boolean account = request.containsKey("accountMode");
        boolean block = "block".equals(request.get("accountMode"));
        int keyIndex = account ? Integer.parseInt(request.getString("keyIndex")) : 0;
        if (keyIndex < 0 || keyIndex >= (block ? 32 : 64)) throw new IllegalArgumentException("Invalid index");
        String phrase = request.getString("seed");
        if (!account) phrase = org.minima.system.commands.CommandRunner.getRunner()
                .getCommand("keys action:genkey phrase:\"" + phrase + "\"").getParam("phrase");
        MiniData base = org.minima.utils.BIP39.convertStringToSeed(phrase);
        if (request.containsKey("expectedSeed") && !base.to0xString().equalsIgnoreCase(request.getString("expectedSeed")))
            throw new IllegalArgumentException("Node seed mismatch");
        boolean[] consumed = { false };
        WalletCore wallet = new WalletCore(base, index -> {
            int leaf = Integer.parseInt(request.getString("leaf"));
            if (index != keyIndex || leaf < 0 || leaf >= (block ? 268435456 : 262144) || consumed[0])
                throw new IllegalArgumentException("Invalid leaf reservation");
            consumed[0] = true;
            return leaf;
        }) {
            @Override public org.minima.objects.keys.TreeKey deriveTreeKey(int index) {
                return block ? new org.minima.objects.keys.TreeKey(derivePrivateSeed(index), 128, 4) : super.deriveTreeKey(index);
            }
            @Override public org.minima.objects.Address getReceiveAddress() { return getAddress(keyIndex); }
        };
        JSONObject result = new JSONObject();
        if ("addresses".equals(request.get("action")) && account) {
            JSONArray keys = new JSONArray();
            for (int i = 0; i < (block ? 32 : 64); i++) keys.add(address(wallet, i));
            result.put("keys", keys);
            return result;
        }
        if ("derive".equals(request.get("action"))) return address(wallet, keyIndex);
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
            inputs.add(TxnFactory.fromExportedCoin(coin, keyIndex));
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
        built.getWitness().addScript(new ScriptProof(wallet.getScript(keyIndex)));
        TxnRow row = new TxnRow(id, built.getTransaction(), built.getWitness());
        result.put("data", MiniData.getMiniDataVersion(row).to0xString());
        return result;
    }

    private static JSONObject address(WalletCore wallet, int index) {
        JSONObject result = new JSONObject();
        result.put("publickey", wallet.getPublicKey(index).to0xString());
        result.put("script", wallet.getScript(index));
        result.put("address", wallet.getAddress(index).getAddressData().to0xString());
        result.put("miniaddress", wallet.getAddress(index).getMinimaAddress());
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
