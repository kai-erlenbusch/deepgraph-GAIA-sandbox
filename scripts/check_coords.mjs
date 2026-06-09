import { tableFromIPC } from 'apache-arrow';

async function main() {
  const url = 'https://files.benschmidt.org/tiles/gaia/0/0/0.feather';
  const res = await fetch(url, { headers: { 'Referer': 'https://benschmidt.org/' }});
  const buf = await res.arrayBuffer();
  const table = tableFromIPC(buf);
  const x = table.getChild('x').toArray();
  const y = table.getChild('y').toArray();
  console.log('X min/max:', Math.min(...x), Math.max(...x));
  console.log('Y min/max:', Math.min(...y), Math.max(...y));
  
  const url2 = 'https://files.benschmidt.org/tiles/gaia/1/0/0.feather';
  const res2 = await fetch(url2, { headers: { 'Referer': 'https://benschmidt.org/' }});
  const buf2 = await res2.arrayBuffer();
  const table2 = tableFromIPC(buf2);
  const x2 = table2.getChild('x').toArray();
  const y2 = table2.getChild('y').toArray();
  console.log('Tile 1/0/0 X min/max:', Math.min(...x2), Math.max(...x2));
  console.log('Tile 1/0/0 Y min/max:', Math.min(...y2), Math.max(...y2));
}
main().catch(console.error);
