import { tableFromIPC } from 'apache-arrow';

async function main() {
  const url2 = 'https://files.benschmidt.org/tiles/gaia/1/0/1.feather';
  const res2 = await fetch(url2, { headers: { 'Referer': 'https://benschmidt.org/' }});
  const buf2 = await res2.arrayBuffer();
  const table2 = tableFromIPC(buf2);
  const x2 = table2.getChild('x').toArray();
  const y2 = table2.getChild('y').toArray();
  console.log('Tile 1/0/1 X min/max:', Math.min(...x2), Math.max(...x2));
  console.log('Tile 1/0/1 Y min/max:', Math.min(...y2), Math.max(...y2));
}
main().catch(console.error);
