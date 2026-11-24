// Asks a node jar (the plain node or the Parlons Node, which embeds it) whether it accepts the three Keets settings
// the app sends, WITHOUT starting a node: ParamConfigurer.checkParams only parses. Used by scripts/keets-test.cjs.
//   java -cp <jar> scripts/fixtures/KeetsFlagsCheck.java   → prints one line per setting and exits 0, or exits 1
import org.minima.system.params.GeneralParams;
import org.minima.system.params.ParamConfigurer;

public class KeetsFlagsCheck {
    public static void main(String[] a) {
        String[][] settings = { {"-keets"}, {"-keets", "-keetschatonly"}, {} };
        boolean[][] want = { {true, false}, {true, true}, {false, false} };
        boolean ok = true;
        for (int i = 0; i < settings.length; i++) {
            GeneralParams.resetDefaults();
            boolean parsed = ParamConfigurer.checkParams(settings[i]);
            boolean right = parsed && GeneralParams.KEETS_ENABLED == want[i][0] && GeneralParams.KEETS_CHAT_ONLY == want[i][1];
            System.out.println(String.join(" ", settings[i]) + " -> parsed " + parsed + ", keets " + GeneralParams.KEETS_ENABLED + ", chat only " + GeneralParams.KEETS_CHAT_ONLY + (right ? "" : "  WRONG"));
            ok &= right;
        }
        System.exit(ok ? 0 : 1);
    }
}
