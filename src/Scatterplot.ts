import * as THREE from 'three';
import { MeshBasicNodeMaterial, StorageInstancedBufferAttribute } from 'three/webgpu';
import { 
  attribute, float, positionLocal, vec3, vec4, vec2, uv, distance, smoothstep,
  hash, instanceIndex, max, select, uint, mix, clamp, log2, uniform, varying, instancedArray, storage, cameraProjectionMatrix, cameraViewMatrix, atomicAdd, time
} from 'three/tsl';
import { Renderer } from './core/Renderer';
import { BoundingBox, TileData } from './data/TileManager';
import { isWarmPalette, warmPaletteColors, coolPaletteColors, paletteUniform } from './main';

export class Scatterplot {
  public scene: THREE.Scene;
  
  public maxTiles = 800;
  public rowsPerTile = 65536;
  public maxGlobalRows = this.maxTiles * this.rowsPerTile;
  
  public globalMesh: THREE.Mesh;
  public slotToTileKey: string[] = new Array(this.maxTiles).fill('');
  public tileKeyToSlot: Map<string, number> = new Map();
  public globalHoverBuffer: Int32Array = new Int32Array(this.maxGlobalRows * 3);
  
  private quadGeometry = new THREE.PlaneGeometry(1, 1);

  public pickingRenderTarget: THREE.RenderTarget;
  public hoverMesh: THREE.Mesh;
  public hoverColorUniform: any;
  public maxIxUniform = uniform(100000000.0);
  public vpMatrixUniform = uniform(new THREE.Matrix4());
  private rootArea: number;
  private rendererWrapper: Renderer;

  constructor(scene: THREE.Scene, rendererWrapper: Renderer, rootBounds: BoundingBox) {
    this.scene = scene;
    this.rendererWrapper = rendererWrapper;
    this.rootArea = (rootBounds.maxX - rootBounds.minX) * (rootBounds.maxY - rootBounds.minY);

    this.hoverColorUniform = uniform(new THREE.Color(0xffffff));
    const hoverGeo = new THREE.PlaneGeometry(1, 1);
    const hoverMat = new MeshBasicNodeMaterial({ 
      transparent: true, 
      depthTest: false,
      blending: THREE.NormalBlending,
      side: THREE.DoubleSide
    });
    
    const d = distance(uv(), vec2(0.5));
    const isBorder = d.greaterThan(0.35);
    const finalColor = select(isBorder, vec3(0.0, 0.0, 0.0), this.hoverColorUniform);
    hoverMat.colorNode = finalColor;
    hoverMat.opacityNode = select(d.lessThan(0.5), float(1.0), float(0.0));
    
    this.hoverMesh = new THREE.Mesh(hoverGeo, hoverMat);
    this.hoverMesh.visible = false;
    this.scene.add(this.hoverMesh);

    this.pickingRenderTarget = new THREE.RenderTarget(1, 1, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: true
    });

    // 1. Pre-allocate exactly one global mesh to handle up to 800 tiles (52 million points)
    const instancedGeometry = new THREE.InstancedBufferGeometry();
    instancedGeometry.index = this.quadGeometry.index;
    instancedGeometry.attributes.position = this.quadGeometry.attributes.position;
    instancedGeometry.attributes.uv = this.quadGeometry.attributes.uv;
    
    instancedGeometry.setAttribute('offsetX', new StorageInstancedBufferAttribute(new Float32Array(this.maxGlobalRows), 1));
    instancedGeometry.setAttribute('offsetY', new StorageInstancedBufferAttribute(new Float32Array(this.maxGlobalRows), 1));
    instancedGeometry.setAttribute('pointIx', new StorageInstancedBufferAttribute(new Float32Array(this.maxGlobalRows), 1));
    instancedGeometry.setAttribute('instanceColor', new StorageInstancedBufferAttribute(new Float32Array(this.maxGlobalRows), 1));
    instancedGeometry.setAttribute('instanceSize', new StorageInstancedBufferAttribute(new Float32Array(this.maxGlobalRows), 1));
    instancedGeometry.setAttribute('spawnTime', new StorageInstancedBufferAttribute(new Float32Array(this.maxGlobalRows).fill(-1000.0), 1));
    
    instancedGeometry.instanceCount = this.maxGlobalRows;

    this.globalMesh = new THREE.Mesh(instancedGeometry, null as any);
    this.globalMesh.frustumCulled = false; // We do our own GPU culling

    // Setup Materials (1 Main, 1 Picking)
    this.globalMesh.material = this.createMainMaterial(instancedGeometry);
    this.globalMesh.userData.pickingMaterial = this.createPickingMaterial(instancedGeometry);

    this.scene.add(this.globalMesh);
  }

  private createMainMaterial(geo: THREE.InstancedBufferGeometry) {
    // Color is now a Float32Array storing bp_rp values
    const colorBuffer = storage(geo.attributes.instanceColor, 'float', this.maxGlobalRows).toReadOnly();
    const sizeBuffer = storage(geo.attributes.instanceSize, 'float', this.maxGlobalRows).toReadOnly();
    const offsetXBuffer = storage(geo.attributes.offsetX, 'float', this.maxGlobalRows).toReadOnly();
    const offsetYBuffer = storage(geo.attributes.offsetY, 'float', this.maxGlobalRows).toReadOnly();
    const pointIxBuffer = storage(geo.attributes.pointIx, 'float', this.maxGlobalRows).toReadOnly();
    const spawnTimeBuffer = storage(geo.attributes.spawnTime, 'float', this.maxGlobalRows).toReadOnly();

    const mat = new MeshBasicNodeMaterial({
      transparent: true,
      alphaTest: 0.001,
      depthWrite: false,
      depthTest: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor, // True Additive Blending
      blendEquation: THREE.AddEquation,
      side: THREE.DoubleSide
    });

    const zoomT = this.rendererWrapper.zoomTUniform;
    const targetPixels = mix(float(1.0), float(2.0), zoomT);
    
    // Read raw attributes
    const rawMag = sizeBuffer.element(instanceIndex);
    const rawColor = colorBuffer.element(instanceIndex);
    
    // Handle NaNs natively in the shader (NaN != NaN is True)
    const isMagNaN = rawMag.equal(rawMag).not();
    const safeRawMag = select(isMagNaN, float(20.0), rawMag);
    
    const isColorNaN = rawColor.equal(rawColor).not();
    const safeRawColor = select(isColorNaN, float(0.0), rawColor);
    
    // Scale and cap the base size (using safeRawMag)
    const computedSize = max(float(0.05), float(21.0).sub(safeRawMag).div(float(10.0)));
    const instanceSize = mix(float(0.8), float(3.0), zoomT).mul(computedSize);
    
    const pointIx = pointIxBuffer.element(instanceIndex);
    const isVisible = sizeBuffer.element(instanceIndex).greaterThan(0.0)
                      .and(pointIx.lessThanEqual(this.maxIxUniform));
    const safeSize = select(isVisible, targetPixels.mul(this.rendererWrapper.worldUnitsPerPixelUniform).mul(instanceSize), float(0.0));
    
    // GAIA needs extreme low alpha to allow 1.8B points to sum without washing out
    // We scale opacity inversely with point density (zoom)
    const baseOpacity = mix(float(0.002), float(0.05), zoomT);
    const dynamicOpacity = clamp(baseOpacity, float(1.0 / 255.0), float(1.0));

    const val = safeRawColor;

    // GAIA bp_rp continuous scale: Domain is [-5.0, 5.0]
    // Negative = Blue, 0 = White, Positive = Red
    const cBlue = vec3(0x11/255.0, 0x22/255.0, 0xaa/255.0);
    const cLtBlue = vec3(0x55/255.0, 0xaa/255.0, 0xdd/255.0);
    const cWhite = vec3(1.0, 1.0, 1.0);
    const cOrange = vec3(0xff/255.0, 0x99/255.0, 0x00/255.0);
    const cRed = vec3(0xcc/255.0, 0x22/255.0, 0x00/255.0);

    // Smoothstep maps val across the domain
    const mix1 = smoothstep(-5.0, -2.5, val);
    const mix2 = smoothstep(-2.5, 0.0, val);
    const mix3 = smoothstep(0.0, 2.5, val);
    const mix4 = smoothstep(2.5, 5.0, val);

    // Chain the mixes together
    let color = mix(cBlue, cLtBlue, mix1);
    color = mix(color, cWhite, mix2);
    color = mix(color, cOrange, mix3);
    const baseColor = mix(color, cRed, mix4);
    
    const threshold = float(1.0 / 255.0);
    const distanceToCenter = distance(uv(), vec2(0.5));
    const alphaEdge = float(1.0).sub(smoothstep(float(0.35), float(0.5), distanceToCenter));
    const finalAlpha = alphaEdge.mul(dynamicOpacity);

    const isSubPixelOpacity = finalAlpha.lessThan(threshold);
    const randomVal = varying(hash(instanceIndex).mul(float(255.0)));
    const probDiscard = randomVal.greaterThan(finalAlpha.mul(float(255.0)));
    
    // Opacity Fade-in
    const spawnTime = spawnTimeBuffer.element(instanceIndex);
    const age = time.sub(spawnTime);
    const fadeAlpha = smoothstep(0.0, 0.3, age);
    
    const shouldDiscard = distanceToCenter.greaterThan(0.5).or(isSubPixelOpacity.and(probDiscard));
    const safeAlpha = select(shouldDiscard, float(0.0), max(finalAlpha, threshold).mul(fadeAlpha));

    mat.colorNode = baseColor.rgb.mul(safeAlpha);
    mat.opacityNode = safeAlpha;
    
    const offset3D = vec3(offsetXBuffer.element(instanceIndex), offsetYBuffer.element(instanceIndex), float(0.0));
    mat.positionNode = select(isVisible, offset3D.add(positionLocal.mul(safeSize)), vec3(1000000.0));

    return mat;
  }

  private createPickingMaterial(geo: THREE.InstancedBufferGeometry) {
    const sizeBuffer = storage(geo.attributes.instanceSize, 'float', this.maxGlobalRows).toReadOnly();
    const offsetXBuffer = storage(geo.attributes.offsetX, 'float', this.maxGlobalRows).toReadOnly();
    const offsetYBuffer = storage(geo.attributes.offsetY, 'float', this.maxGlobalRows).toReadOnly();
    const pointIxBuffer = storage(geo.attributes.pointIx, 'float', this.maxGlobalRows).toReadOnly();

    const mat = new MeshBasicNodeMaterial({
      transparent: true,
      alphaTest: 0.001,
      blending: THREE.NoBlending,
      depthWrite: true,
      depthTest: true,
      side: THREE.DoubleSide
    });

    // Encode global sortedIndex as a 32-bit Integer packed into RGBA
    // We add 0x01000000 so the 4th byte (Alpha) is ALWAYS >= 1. 
    // This perfectly bypasses alphaTest=0.001 for valid pixels, but lets us output 0.0 alpha to trigger native Discard!
    const fInstanceIndex = uint(instanceIndex).add(0x01000000);
    
    const r = float(fInstanceIndex.bitAnd(0xFF)).div(255.0);
    const g = float(fInstanceIndex.shiftRight(8).bitAnd(0xFF)).div(255.0);
    const b = float(fInstanceIndex.shiftRight(16).bitAnd(0xFF)).div(255.0);
    const a = float(fInstanceIndex.shiftRight(24).bitAnd(0xFF)).div(255.0);
    
    mat.colorNode = vec3(r, g, b);
    
    const pointIx = pointIxBuffer.element(instanceIndex);
    const isVisible = sizeBuffer.element(instanceIndex).greaterThan(0.0)
                      .and(pointIx.lessThanEqual(this.maxIxUniform));
    const distanceToCenter = distance(uv(), vec2(0.5));
    const shouldDiscard = distanceToCenter.greaterThan(0.5).or(isVisible.not());
    mat.opacityNode = select(shouldDiscard, float(0.0), a);
    
    const zoomT = this.rendererWrapper.zoomTUniform;
    const targetPixels = mix(float(1.0), float(2.0), zoomT);
    const instanceSize = mix(float(0.8), float(3.0), zoomT).mul(sizeBuffer.element(instanceIndex));
    const safeSize = targetPixels.mul(this.rendererWrapper.worldUnitsPerPixelUniform).mul(instanceSize);

    const offset3D = vec3(offsetXBuffer.element(instanceIndex), offsetYBuffer.element(instanceIndex), float(0.0));
    mat.positionNode = select(isVisible, offset3D.add(positionLocal.mul(safeSize)), vec3(1000000.0));

    return mat;
  }

  public updateCamera(camera: THREE.Camera) {
    const vp = new THREE.Matrix4();
    vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.vpMatrixUniform.value.copy(vp);
    
    // Dynamic Density Culling (Progressive Subsampling)
    const orthoCam = camera as THREE.OrthographicCamera;
    const visibleWidth = (orthoCam.right - orthoCam.left) / camera.zoom;
    const visibleHeight = (orthoCam.top - orthoCam.bottom) / camera.zoom;
    
    // Scale-invariant zoom calculation
    const currentZoom = Math.log2(Math.max(1.0, camera.zoom));
    const zoomT = Math.max(0.0, Math.min(1.0, currentZoom / 6.0));
    
    // Maintain a constant density of roughly 3M points across the visible screen
    const visibleArea = visibleWidth * visibleHeight;
    const safeRootArea = this.rootArea > 0 ? this.rootArea : 1;
    const areaRatio = safeRootArea / visibleArea;
    
    const targetPointsOnScreen = 3000000;
    this.maxIxUniform.value = targetPointsOnScreen * areaRatio;
  }

    private getFreeSlot(): number {
      for (let i = 0; i < this.maxTiles; i++) {
          if (this.slotToTileKey[i] === '') return i;
      }
      return -1;
    }

    private writeToGPUBuffer(attribute: StorageInstancedBufferAttribute, dstByteOffset: number, data: ArrayBuffer, srcByteOffset: number, byteLength: number): boolean {
      try {
        const backend = (this.rendererWrapper.renderer as any).backend;
        if (!backend) return false;
        const gpuData = backend.get(attribute);
        if (gpuData && gpuData.buffer) {
            const device = backend.device as GPUDevice;
            device.queue.writeBuffer(gpuData.buffer, dstByteOffset, data, srcByteOffset, byteLength);
            return true;
        }
      } catch(e) {
         // Fallback on error
      }
      return false;
    }

    private globalZeroBuffer: ArrayBuffer = new Float32Array(this.rowsPerTile).buffer;

    public unloadTile(key: string) {
        const slot = this.tileKeyToSlot.get(key);
        if (slot !== undefined) {
            this.slotToTileKey[slot] = '';
            this.tileKeyToSlot.delete(key);
            
            const sizeAttr = this.globalMesh.geometry.attributes.instanceSize as StorageInstancedBufferAttribute;
            const offset = slot * this.rowsPerTile;
            
            const wrote = this.writeToGPUBuffer(sizeAttr, offset * 4, this.globalZeroBuffer, 0, this.globalZeroBuffer.byteLength);
            if (!wrote) {
                (sizeAttr.array as Float32Array).fill(0.0, offset, offset + this.rowsPerTile);
                sizeAttr.needsUpdate = true;
            }
        }
    }

    public updateTiles(tiles: TileData[]) {
        const currentKeys = new Set(tiles.map(t => t.key));
        
        // We remove the contiguous MAX_UPDATE_ROWS limit because disjoint writeBuffer calls 
        // solve the PCIe over-fetching natively. We can process more tiles per frame safely.
        const MAX_PROCESS_TILES = 20; 
        let processedTiles = 0;
        
        let minUpdateOffset = Infinity;
        let maxUpdateOffset = -1;
        let needsFallbackUpdate = false;

        // Remove the aggressive frame-by-frame GC!
        // Tiles are only unloaded when `unloadTile` is called by TileManager.
        
        let maxSlotUsed = -1;
        for (let i = 0; i < this.maxTiles; i++) {
            if (this.slotToTileKey[i] !== '') maxSlotUsed = i;
        }

    // 2. Process added/updated tiles
    for (const tile of tiles) {
      if (!this.tileKeyToSlot.has(tile.key)) {
        const slot = this.getFreeSlot();
        if (slot === -1) continue; // Out of slots (exceeds maxTiles)
        
        this.tileKeyToSlot.set(tile.key, slot);
        this.slotToTileKey[slot] = tile.key;
        tile.needsUpdate = true;
      }
      
      const slot = this.tileKeyToSlot.get(tile.key)!;
      if (slot > maxSlotUsed) maxSlotUsed = slot;

      if (tile.needsUpdate) {
        if (processedTiles >= MAX_PROCESS_TILES) continue;
        processedTiles++;
        
        const offset = slot * this.rowsPerTile;
        const geo = this.globalMesh.geometry;
        
        let tileNeedsFallback = false;
        
        if (tile.xBuffer) {
            const ixBuf = tile.ixBuffer || new Float32Array(this.rowsPerTile).buffer;
            const wroteX = this.writeToGPUBuffer(geo.attributes.offsetX as StorageInstancedBufferAttribute, offset * 4, tile.xBuffer, 0, tile.xBuffer.byteLength);
            if (wroteX) {
                this.writeToGPUBuffer(geo.attributes.offsetY as StorageInstancedBufferAttribute, offset * 4, tile.yBuffer!, 0, tile.yBuffer!.byteLength);
                this.writeToGPUBuffer(geo.attributes.pointIx as StorageInstancedBufferAttribute, offset * 4, ixBuf, 0, ixBuf.byteLength);
            } else {
                (geo.attributes.offsetX as StorageInstancedBufferAttribute).array.set(new Float32Array(tile.xBuffer), offset);
                (geo.attributes.offsetY as StorageInstancedBufferAttribute).array.set(new Float32Array(tile.yBuffer!), offset);
                (geo.attributes.pointIx as StorageInstancedBufferAttribute).array.set(new Float32Array(ixBuf), offset);
                needsFallbackUpdate = true;
                tileNeedsFallback = true;
            }
        }
        
        if (tile.colorBuffer) {
            const currentTime = performance.now() / 1000.0;
            const spawnTimeArray = new Float32Array(this.rowsPerTile).fill(currentTime);

            const wroteC = this.writeToGPUBuffer(geo.attributes.instanceColor as StorageInstancedBufferAttribute, offset * 4, tile.colorBuffer, 0, tile.colorBuffer.byteLength);
            if (wroteC) {
                this.writeToGPUBuffer(geo.attributes.instanceSize as StorageInstancedBufferAttribute, offset * 4, tile.sizeBuffer!, 0, tile.sizeBuffer!.byteLength);
                this.writeToGPUBuffer(geo.attributes.spawnTime as StorageInstancedBufferAttribute, offset * 4, spawnTimeArray.buffer, 0, spawnTimeArray.byteLength);
            } else {
                (geo.attributes.instanceColor as StorageInstancedBufferAttribute).array.set(new Float32Array(tile.colorBuffer), offset);
                (geo.attributes.instanceSize as StorageInstancedBufferAttribute).array.set(new Float32Array(tile.sizeBuffer!), offset);
                (geo.attributes.spawnTime as StorageInstancedBufferAttribute).array.set(spawnTimeArray, offset);
                needsFallbackUpdate = true;
                tileNeedsFallback = true;
            }
        }
        
        if (tile.hoverBuffer) {
            this.globalHoverBuffer.set(new Int32Array(tile.hoverBuffer), offset * 3);
        }

        if (tileNeedsFallback) {
            minUpdateOffset = Math.min(minUpdateOffset, offset);
            maxUpdateOffset = Math.max(maxUpdateOffset, offset + this.rowsPerTile);
        }

        tile.needsUpdate = false;
      }
    }

    if (needsFallbackUpdate && maxUpdateOffset > -1) {
        const geo = this.globalMesh.geometry;
        const updateCount = maxUpdateOffset - minUpdateOffset;
        const range = { offset: minUpdateOffset, count: updateCount };
        
        const attrs = ['offsetX', 'offsetY', 'pointIx', 'instanceColor', 'instanceSize', 'spawnTime'];
        for (const attr of attrs) {
            const a = geo.attributes[attr] as StorageInstancedBufferAttribute;
            a.updateRange = range;
            a.needsUpdate = true;
        }
    }
    
    // We can shrink the instanceCount to save vertex shader invocations on empty top end!
    if (maxSlotUsed >= 0) {
        const activeRows = (maxSlotUsed + 1) * this.rowsPerTile;
        this.globalMesh.geometry.instanceCount = activeRows;
    } else {
        this.globalMesh.geometry.instanceCount = 0;
    }
  }

  public updateHover(globalId: number, tooltipHtmlCallback: (html: string) => void) {
      if (globalId < 0 || globalId >= this.maxGlobalRows) {
        this.hoverMesh.visible = false;
        return;
      }
      
      const slotIndex = Math.floor(globalId / this.rowsPerTile);
      const rowIndex = globalId % this.rowsPerTile;
      const tileKey = this.slotToTileKey[slotIndex];
      
      if (tileKey === "") {
        this.hoverMesh.visible = false;
        return;
      }
  
      const offsetX = (this.globalMesh.geometry.attributes.offsetX as StorageInstancedBufferAttribute).array as Float32Array;
      const offsetY = (this.globalMesh.geometry.attributes.offsetY as StorageInstancedBufferAttribute).array as Float32Array;
      const sizeBuffer = (this.globalMesh.geometry.attributes.instanceSize as StorageInstancedBufferAttribute).array as Float32Array;
      
      const x = offsetX[globalId];
      const y = offsetY[globalId];
      this.hoverMesh.position.set(x, y, 0.0);
      
      // Sync hover scale precisely with the visual shader scale
      const currentZoom = Math.log2(Math.max(1.0, this.rendererWrapper.camera.zoom));
      const zoomT = Math.max(0, Math.min(1.0, currentZoom / 6.0));
      const targetPixels = 1.0 * (1.0 - zoomT) + 2.0 * zoomT;
      const baseInstanceSize = 0.8 * (1.0 - zoomT) + 3.0 * zoomT;
      const instanceSize = sizeBuffer[globalId];
      
      const physicalSize = targetPixels * baseInstanceSize * instanceSize * worldUnitsPerPixel * 4.0;
      this.hoverMesh.scale.set(physicalSize, physicalSize, 1.0);
      
      this.hoverMesh.visible = true;
      
      let hoverText = `Tile: ${tileKey}<br/>Row: ${rowIndex}`;
      
      // Global hover buffer uses 3 Int32s per row
      const global_id = this.globalHoverBuffer[globalId * 3 + 0];
      const model_id = this.globalHoverBuffer[globalId * 3 + 1];
      const num_of_tokens = this.globalHoverBuffer[globalId * 3 + 2];
      
      if (global_id !== 0 || model_id !== 0 || num_of_tokens !== 0) {
         hoverText = `Global ID: ${global_id}<br/>Model ID: ${model_id}<br/>Tokens: ${num_of_tokens}`;
      } else {
         hoverText += `<br/><i>Loading semantic data...</i>`;
      }
      tooltipHtmlCallback(hoverText);
  }
}
