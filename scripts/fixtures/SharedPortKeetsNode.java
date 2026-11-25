import org.minima.Minima;
import org.minima.system.network.minima.NIOHandoff;

/** Entry point for the existing private two-node Keets chain-sync test.
 * Installing the same handoff interface as Parlons exercises the shared port's frame queue.
 * Neither chain peer in this test is a relay client.
 */
public class SharedPortKeetsNode {
    public static void main(String[] args) throws Exception {
        NIOHandoff.HANDLER = (channel, greeting, leftover, source) -> {
            throw new AssertionError("A Keets chain peer was handed to the relay");
        };
        Minima.main(args);
    }
}
