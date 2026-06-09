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
  const { tileUrl, key } = e.data;
  
  try {
    const res = await fetch(tileUrl, { cache: 'no-cache' });
    if (!res.ok) throw new Error((res.status === 404 || res.status === 403) ? '404' : `HTTP ${res.status}`);
    
    const bufferArray = await res.arrayBuffer();
    
    // Check if Vite SPA returned an HTML file instead of IPC data
    const headerCheck = new Uint8Array(bufferArray, 0, Math.min(15, bufferArray.byteLength));
    const headerStr = String.fromCharCode.apply(null, Array.from(headerCheck));
    if (headerStr.includes('<html') || headerStr.includes('<!doc')) {
      throw new Error('404');
    }
    
    const table = tableFromIPC(bufferArray);
    const numRows = table.numRows;
    
    // --- METADATA EXTRACTION ---
    let childrenKeys: string[] | null = null;
    let extent: any = null;
    if (table.schema.metadata) {
      const childrenStr = table.schema.metadata.get('children');
      if (childrenStr) {
        try {
          childrenKeys = JSON.parse(childrenStr);
        } catch(e) {}
      }
      const extentStr = table.schema.metadata.get('extent');
      if (extentStr) {
        try {
          extent = JSON.parse(extentStr);
        } catch(e) {}
      }
    }
    
    // --- GEOMETRY EXTRACTION (ZERO-EXTRACTION PIPELINE) ---
    // Instead of mapping the IPC buffer into new Javascript Float32Arrays,
    // we extract the raw underlying memory buffers.
    
    const getBuffer = (child: any) => {
        if (!child || child.data.length === 0) return new Float32Array(numRows).buffer;
        const values = child.data[0].values; // This is a Uint8Array or Float32Array view of the raw IPC buffer
        // Slice creates a very fast transferrable copy of the exact chunk without JS iteration overhead
        return values.buffer.slice(values.byteOffset, values.byteOffset + values.byteLength);
    };

    const xChild = table.getChild('x_umap') || table.getChild('x');
    const xBuffer = getBuffer(xChild);
    
    const yChild = table.getChild('y_umap') || table.getChild('y');
    const yBuffer = getBuffer(yChild);
    
    const ixCol = table.getChild('ix');
    const ixBuffer = getBuffer(ixCol);
    
    self.postMessage(
      { key, stage: 'geom', xBuffer, yBuffer, ixBuffer, numRows, childrenKeys, extent }, 
      { transfer: [xBuffer, yBuffer, ixBuffer] }
    );
    
    // --- SEMANTIC EXTRACTION ---
    const globalIdCol = table.getChild('global_id') || table.getChild('__index_level_0__');
    const globalIds = globalIdCol ? globalIdCol.toArray() : null;
    
    const modelIdCol = table.getChild('model_id') || table.getChild('model');
    const modelIds = modelIdCol ? modelIdCol.toArray() : null;
    
    const tokensCol = table.getChild('num_of_tokens');
    const tokensArray = tokensCol ? tokensCol.toArray() : null;

    const ixArray = ixCol ? ixCol.toArray() : null;

    // GAIA specific columns
    const bpRpCol = table.getChild('bp_rp');
    const colorBuffer = getBuffer(bpRpCol);
    
    const magCol = table.getChild('phot_g_mean_mag');
    let sizeBuffer: ArrayBuffer;
    if (magCol) {
        sizeBuffer = getBuffer(magCol);
    } else if (tokensArray) {
        const floatSizes = new Float32Array(numRows);
        for (let i = 0; i < numRows; i++) {
            floatSizes[i] = Math.max(0.5, Math.log10(Math.max(Number(tokensArray[i]), 1)));
        }
        sizeBuffer = floatSizes.buffer;
    } else {
        sizeBuffer = new Float32Array(numRows).fill(20.0).buffer;
    }
    
    const hoverBuffer = new Int32Array(numRows * 3);
    for (let i = 0; i < numRows; i++) {
      hoverBuffer[i * 3 + 0] = globalIds ? Number(globalIds[i]) : i;
      hoverBuffer[i * 3 + 1] = modelIds ? Number(modelIds[i]) : 0;
      hoverBuffer[i * 3 + 2] = ixArray ? Number(ixArray[i]) : (tokensArray ? Number(tokensArray[i]) : 10);
    }
    
    self.postMessage(
      { key, stage: 'semantic', colorBuffer: colorBuffer, sizeBuffer: sizeBuffer, hoverBuffer: hoverBuffer.buffer }, 
      { transfer: [colorBuffer, sizeBuffer, hoverBuffer.buffer] }
    );
    
  } catch (err) {
    self.postMessage({ key, error: err instanceof Error ? err.message : String(err) });
  }
};
