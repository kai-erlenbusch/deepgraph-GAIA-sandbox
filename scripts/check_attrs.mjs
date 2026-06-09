import { tableFromIPC } from 'apache-arrow';

async function main() {
  const url = 'https://files.benschmidt.org/tiles/gaia/0/0/0.feather';
  const res = await fetch(url, { headers: { 'Referer': 'https://benschmidt.org/' }});
  const buf = await res.arrayBuffer();
  const table = tableFromIPC(buf);
  
  const bpRp = table.getChild('bp_rp').toArray();
  const mag = table.getChild('phot_g_mean_mag').toArray();
  
  // Filter out any NaN or infinite values
  const validBpRp = Array.from(bpRp).filter(v => !Number.isNaN(v) && Number.isFinite(v));
  const validMag = Array.from(mag).filter(v => !Number.isNaN(v) && Number.isFinite(v));
  
  console.log('bp_rp min/max:', Math.min(...validBpRp), Math.max(...validBpRp));
  console.log('phot_g_mean_mag min/max:', Math.min(...validMag), Math.max(...validMag));
}
main().catch(console.error);
