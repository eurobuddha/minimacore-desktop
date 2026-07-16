import { upnpNat, pmpNat } from '@achingbrain/nat-port-mapper';
import { execFile } from 'child_process';
const PORT = 12001;
function route() { return new Promise(r => execFile('route', ['-n','get','default'], (e,o)=> r(e?null:{gw:(/gateway:\s*([0-9.]+)/.exec(o)||[])[1], iface:(/interface:\s*(\S+)/.exec(o)||[])[1]}))); }
import os from 'os';
const rt = await route();
const lan = (os.networkInterfaces()[rt?.iface]||[]).find(n=>n.family==='IPv4'&&!n.internal)?.address;
console.log('default route:', rt, 'lan ip:', lan);
let gw = null, method = null;
try {
  for await (const g of upnpNat().findGateways({ signal: AbortSignal.timeout(10000) })) {
    console.log('UPnP gateway found:', g.id, g.host, g.family);
    if (g.family === 'IPv4') { gw = g; method = 'upnp'; break; }
  }
} catch (e) { console.log('UPnP discovery failed:', e.message); }
if (!gw && rt?.gw) {
  const g = pmpNat(rt.gw);
  try { const ip = await g.externalIp(); console.log('NAT-PMP external IP:', ip); gw = g; method = 'natpmp'; }
  catch (e) { console.log('NAT-PMP failed:', e.message); try { await g.stop(); } catch {} }
}
if (!gw) { console.log('RESULT: no gateway (UPnP off + no NAT-PMP)'); process.exit(0); }
console.log('method:', method);
try {
  const ext = await gw.externalIp();
  console.log('external IP:', ext);
  const m = await gw.map(PORT, lan, { externalPort: PORT, protocol: 'tcp', description: 'minimaCore preflight test' });
  console.log('mapping granted:', JSON.stringify(m));
  console.log(m.externalPort === PORT ? 'RESULT: mapped external==internal OK' : 'RESULT: PORT CONFLICT — granted ' + m.externalPort);
  await gw.unmap(PORT);
  console.log('unmapped OK');
} catch (e) { console.log('map/unmap error:', e.message); }
await gw.stop();
process.exit(0);
