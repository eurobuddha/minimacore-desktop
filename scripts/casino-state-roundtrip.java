// casino-state-roundtrip.java (0.18.338): the proof behind main/casino-settle.js takerValue and the table NODE_READS in
// scripts/casino-settle-test.cjs. For each line of stdin (a state value as the node prints it in `coins`): does the node's VM read
// it (kissvm Value.getValue), and does it come back as the SAME VM value through the node's own command parser
// (CommandRunner.getCommand of "txnstate id:… port:9 value:<it>"), StateVariable, and its wire form? It uses the classes of the
// shipped node only. NO NODE IS STARTED and nothing is contacted. Not part of the gate (it needs javac); run by hand:
//   mkdir /tmp/rt && cp scripts/casino-state-roundtrip.java /tmp/rt/RT.java && cd /tmp/rt && javac -cp <repo>/resources/minima.jar RT.java
//   printf '%s\n' '-1' '[x]' 'TRUE' | java -cp <repo>/resources/minima.jar:. RT
// Output: OK, COVENANT-THROWS (the VM cannot read it: such a bet can never be revealed by anyone), WRITE-THROWS, PARSER-CHANGED
// or DIFFERS, a tab, the value.
import java.io.*;
import org.minima.objects.StateVariable;
import org.minima.kissvm.values.Value;
import org.minima.system.commands.Command;
import org.minima.system.commands.CommandRunner;

/** Does a state value, as the node prints it, come back as the SAME covenant value through `txnstate value:`? No node is started. */
public class RT {
  static String rt(String x) {
    String cv;
    try { cv = Value.getValue(x).toString(); } catch (Throwable e) { return "COVENANT-THROWS " + e.getClass().getSimpleName(); }
    try {
      Command c = CommandRunner.getRunner().getCommand("txnstate id:cs_reveal_1_1 port:9 value:" + x);
      Object id = c.getParams().get("id"), port = c.getParams().get("port"), v = c.getParams().get("value");
      if (c.getParams().size() != 3 || !"cs_reveal_1_1".equals(id) || !"9".equals(port) || !(v instanceof String)) return "PARSER-CHANGED params=" + c.getParams();
      StateVariable sv = new StateVariable(9, (String) v);
      ByteArrayOutputStream bo = new ByteArrayOutputStream(); sv.writeDataStream(new DataOutputStream(bo));
      StateVariable back = StateVariable.ReadFromStream(new DataInputStream(new ByteArrayInputStream(bo.toByteArray())));
      String nv = Value.getValue(back.toString()).toString();
      return nv.equals(cv) ? "OK" : "DIFFERS " + nv + " vs " + cv;
    } catch (Throwable e) { return "WRITE-THROWS " + e.getClass().getSimpleName() + " " + e.getMessage(); }
  }
  public static void main(String[] a) throws Exception {
    BufferedReader in = new BufferedReader(new InputStreamReader(System.in, "UTF-8")); String line;
    while ((line = in.readLine()) != null) System.out.println(rt(line) + "\t" + line);
  }
}
