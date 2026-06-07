import { tableFromIPC } from 'apache-arrow';

// The categorical palette
const hexPalette = [0x173F5F, 0x20639B, 0x3CAEA3, 0xF6D55C, 0xED553B];
const palette = hexPalette.map(h => {
  return [
    (h >> 16) & 255,
    (h >> 8) & 255,
    h & 255
  ];
});

self.onmessage = async (e: MessageEvent) => {
  const { geomUrl, semanticUrl, key } = e.data;
  
  try {
    // --- 1. FETCH GEOMETRY ---
    const geomRes = await fetch(geomUrl, { cache: 'no-cache' });
    if (!geomRes.ok) throw new Error(geomRes.status === 404 ? '404' : `HTTP ${geomRes.status}`);
    
    const geomBufferArray = await geomRes.arrayBuffer();
    
    // Check if Vite SPA returned an HTML file instead of IPC data
    const headerCheck = new Uint8Array(geomBufferArray, 0, Math.min(15, geomBufferArray.byteLength));
    const headerStr = String.fromCharCode.apply(null, Array.from(headerCheck));
    if (headerStr.includes('<html') || headerStr.includes('<!doc')) {
      throw new Error('404');
    }
    
    const geomTable = tableFromIPC(geomBufferArray);
    const numRows = geomTable.numRows;
    
    const xChild = geomTable.getChild('x_umap') || geomTable.getChild('x');
    const xCol = xChild ? xChild.toArray() : new Float32Array(numRows);
    
    const yChild = geomTable.getChild('y_umap') || geomTable.getChild('y');
    const yCol = yChild ? yChild.toArray() : new Float32Array(numRows);
    
    const zChild = geomTable.getChild('z_topo') || geomTable.getChild('z');
    const zCol = zChild ? zChild.toArray() : null;
    
    const geomBuffer = new Float32Array(numRows * 3);
    for (let i = 0; i < numRows; i++) {
      geomBuffer[i * 3 + 0] = xCol[i];
      geomBuffer[i * 3 + 1] = yCol[i];
      geomBuffer[i * 3 + 2] = zCol ? zCol[i] : 0.0;
    }
    
    self.postMessage(
      { key, stage: 'geom', geomBuffer: geomBuffer.buffer, numRows }, 
      { transfer: [geomBuffer.buffer] }
    );
    
    // --- 2. FETCH SEMANTICS ---
    let semTable: any = null;
    if (geomUrl === semanticUrl) {
      semTable = geomTable;
    } else {
      const semRes = await fetch(semanticUrl, { cache: 'no-cache' });
      if (semRes.ok) {
        const semBufferArray = await semRes.arrayBuffer();
        const semHeaderCheck = new Uint8Array(semBufferArray, 0, Math.min(15, semBufferArray.byteLength));
        const semHeaderStr = String.fromCharCode.apply(null, Array.from(semHeaderCheck));
        if (!semHeaderStr.includes('<html') && !semHeaderStr.includes('<!doc')) {
            semTable = tableFromIPC(semBufferArray);
        }
      }
    }
    
    const colorBuffer = new Uint8Array(numRows * 4);
    const sizeBuffer = new Float32Array(numRows);
    const hoverBuffer = new Int32Array(numRows * 3);
    
    if (semTable) {
        const globalIdCol = semTable.getChild('global_id') || semTable.getChild('__index_level_0__');
        const globalIds = globalIdCol ? globalIdCol.toArray() : null;
        
        const modelIdCol = semTable.getChild('model_id') || semTable.getChild('model');
        const modelIds = modelIdCol ? modelIdCol.toArray() : null;
        
        const tokensCol = semTable.getChild('num_of_tokens');
        const tokensArray = tokensCol ? tokensCol.toArray() : null;

        for (let i = 0; i < numRows; i++) {
          let id = modelIds ? Number(modelIds[i]) % 5 : 0;
          const c = palette[id];
          colorBuffer[i * 4 + 0] = c[0];
          colorBuffer[i * 4 + 1] = c[1];
          colorBuffer[i * 4 + 2] = c[2];
          colorBuffer[i * 4 + 3] = 255;
          
          const tokens = tokensArray ? Number(tokensArray[i]) : 10;
          sizeBuffer[i] = Math.max(0.5, Math.log10(Math.max(tokens, 1)));
          
          hoverBuffer[i * 3 + 0] = globalIds ? Number(globalIds[i]) : i;
          hoverBuffer[i * 3 + 1] = modelIds ? Number(modelIds[i]) : 0;
          hoverBuffer[i * 3 + 2] = tokens;
        }
    } else {
        for (let i = 0; i < numRows; i++) {
            colorBuffer[i * 4 + 0] = 128;
            colorBuffer[i * 4 + 1] = 128;
            colorBuffer[i * 4 + 2] = 128;
            colorBuffer[i * 4 + 3] = 255;
            sizeBuffer[i] = 1.0;
        }
    }
    
    self.postMessage(
      { key, stage: 'semantic', colorBuffer: colorBuffer.buffer, sizeBuffer: sizeBuffer.buffer, hoverBuffer: hoverBuffer.buffer }, 
      { transfer: [colorBuffer.buffer, sizeBuffer.buffer, hoverBuffer.buffer] }
    );
    
  } catch (err) {
    self.postMessage({ key, error: err instanceof Error ? err.message : String(err) });
  }
};
