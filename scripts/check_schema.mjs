import { tableFromIPC } from 'apache-arrow';

async function main() {
  const url = 'https://files.benschmidt.org/tiles/gaia/0/0/0.feather';
  console.log('Fetching', url);
  const res = await fetch(url, { headers: { 'Referer': 'https://benschmidt.org/' }});
  const buf = await res.arrayBuffer();
  const table = tableFromIPC(buf);
  console.log('Schema fields:');
  table.schema.fields.forEach(f => console.log(f.name));
  console.log('Number of rows:', table.numRows);
}
main().catch(console.error);
