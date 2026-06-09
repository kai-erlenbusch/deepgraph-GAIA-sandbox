import { tableFromIPC } from 'apache-arrow';

async function main() {
  const url = 'https://files.benschmidt.org/tiles/gaia/0/0/0.feather';
  const res = await fetch(url, { headers: { 'Referer': 'https://benschmidt.org/' }});
  const buf = await res.arrayBuffer();
  const table = tableFromIPC(buf);
  
  const bpRp = table.getChild('bp_rp').toArray();
  
  let nans = 0;
  let lt05 = 0;
  let lt10 = 0;
  let lt15 = 0;
  let lt20 = 0;
  let gt20 = 0;
  for (let i = 0; i < bpRp.length; i++) {
    const val = Number(bpRp[i]);
    if (Number.isNaN(val)) nans++;
    else if (val < 0.5) lt05++;
    else if (val < 1.0) lt10++;
    else if (val < 1.5) lt15++;
    else if (val < 2.0) lt20++;
    else gt20++;
  }
  console.log({nans, lt05, lt10, lt15, lt20, gt20});
}
main().catch(console.error);
