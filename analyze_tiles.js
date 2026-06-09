import { readFileSync } from 'fs';
import { tableFromIPC } from 'apache-arrow';

function analyzeTile(url) {
  try {
    const buffer = readFileSync(url);
    const table = tableFromIPC(buffer);
    const x = table.getChild('x_umap') || table.getChild('x');
    const y = table.getChild('y_umap') || table.getChild('y');
    if (!x || !y) return 'no x/y';
    let minX=Infinity, maxX=-Infinity, minY=Infinity, maxY=-Infinity;
    for (let i=0; i<Math.min(table.numRows, 1000); i++) {
       minX = Math.min(minX, x.get(i));
       maxX = Math.max(maxX, x.get(i));
       minY = Math.min(minY, y.get(i));
       maxY = Math.max(maxY, y.get(i));
    }
    return `rows: ${table.numRows}, X: [${minX.toFixed(2)}, ${maxX.toFixed(2)}], Y: [${minY.toFixed(2)}, ${maxY.toFixed(2)}]`;
  } catch(e) { return 'error ' + e.message; }
}

const basePath = 'D:/exploratory/duckdb-extension/deepgraph-webgpu-sandbox/public/tiles';
console.log('0/0/0:', analyzeTile(basePath + '/0/0/0.geom.arrow'));
console.log('1/0/0:', analyzeTile(basePath + '/1/0/0.geom.arrow'));
console.log('1/1/0:', analyzeTile(basePath + '/1/1/0.geom.arrow'));
console.log('1/0/1:', analyzeTile(basePath + '/1/0/1.geom.arrow'));
console.log('1/1/1:', analyzeTile(basePath + '/1/1/1.geom.arrow'));
