import * as THREE from 'three';
import { MeshBasicNodeMaterial, StorageInstancedBufferAttribute } from 'three/webgpu';
import { 
  attribute, float, positionLocal, vec3, vec4, vec2, uv, distance, smoothstep,
  hash, instanceIndex, max, select, uint, mix, clamp, log2, uniform, varying, instancedArray, storage, cameraProjectionMatrix, cameraViewMatrix, atomicAdd, time, userData
} from 'three/tsl';
import { Renderer } from './core/Renderer';
import { BoundingBox, TileData } from './data/TileManager';


export class Scatterplot {
  public scene: THREE.Scene;
  
  public maxTiles = 800;
  public rowsPerTile = 65536;
  public maxGlobalRows = this.maxTiles * this.rowsPerTile;
  
  public slotMeshes: THREE.Mesh[] = [];
  public slotToTileKey: string[] = new Array(this.maxTiles).fill('');
  public slotToTileData: (TileData | null)[] = new Array(this.maxTiles).fill(null);
  public tileKeyToSlot: Map<string, number> = new Map();
  public globalHoverBuffer: Int32Array = new Int32Array(this.maxGlobalRows * 3);
  
  private quadGeometry = new THREE.PlaneGeometry(1, 1);

  public pickingRenderTarget: THREE.RenderTarget;
  public hoverMesh: THREE.Mesh;
  public hoverColorUniform: any;
  public layerSpacingUniform = uniform(0.0);
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
      depthBuffer: true,
      colorSpace: THREE.NoColorSpace,
      magFilter: THREE.NearestFilter,
      minFilter: THREE.NearestFilter
    });

    // 1. Pre-allocate 800 discrete meshes, perfectly chunking the geometry
    const mainMaterial = this.createMainMaterial();
    const pickingMaterial = this.createPickingMaterial();

    for (let i = 0; i < this.maxTiles; i++) {
        const geo = new THREE.InstancedBufferGeometry();
        geo.index = this.quadGeometry.index;
        geo.attributes.position = this.quadGeometry.attributes.position;
        geo.attributes.uv = this.quadGeometry.attributes.uv;
        
        // Use standard WebGPU Instanced Attributes
        geo.setAttribute('offsetX', new THREE.InstancedBufferAttribute(new Float32Array(this.rowsPerTile), 1));
        geo.setAttribute('offsetY', new THREE.InstancedBufferAttribute(new Float32Array(this.rowsPerTile), 1));
        geo.setAttribute('pointIx', new THREE.InstancedBufferAttribute(new Float32Array(this.rowsPerTile), 1));
        geo.setAttribute('instanceColor', new THREE.InstancedBufferAttribute(new Float32Array(this.rowsPerTile), 1));
        geo.setAttribute('instanceSize', new THREE.InstancedBufferAttribute(new Float32Array(this.rowsPerTile), 1));
        geo.setAttribute('spawnTime', new THREE.InstancedBufferAttribute(new Float32Array(this.rowsPerTile).fill(-1000.0), 1));
        
        geo.instanceCount = 0; // Initialize empty to prevent garbage rendering

        const mesh = new THREE.Mesh(geo, mainMaterial);
        mesh.frustumCulled = false; // We do our own Zero-Cost GPU culling via mesh.visible
        mesh.visible = false;
        mesh.userData.pickingMaterial = pickingMaterial;
        mesh.userData.slotIndex = i; // Assign Slot ID natively for picking shader

        this.slotMeshes.push(mesh);
        this.scene.add(mesh);
    }
  }

  private createMainMaterial() {
    // Abstracted TSL inputs allow ALL 800 meshes to perfectly share this 1 Pipeline!
    const rawColor = attribute('instanceColor', 'float');
    const rawMag = attribute('instanceSize', 'float');
    const offsetX = attribute('offsetX', 'float');
    const offsetY = attribute('offsetY', 'float');
    const pointIx = attribute('pointIx', 'float');
    const spawnTime = attribute('spawnTime', 'float');

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
    
    // Handle NaNs natively in the shader (NaN != NaN is True)
    const isMagNaN = rawMag.equal(rawMag).not();
    const safeRawMag = select(isMagNaN, float(20.0), rawMag);
    
    const isColorNaN = rawColor.equal(rawColor).not();
    const safeRawColor = select(isColorNaN, float(0.0), rawColor);
    
    // Scale and cap the base size 
    // We gracefully handle both GAIA magnitude (<= 21) and Nomic tokens (> 30)
    const isTokens = safeRawMag.greaterThan(30.0);
    const tokenSize = max(float(0.5), log2(max(safeRawMag, float(1.0))));
    const gaiaSize = max(float(0.05), float(21.0).sub(safeRawMag).div(float(10.0)));
    const computedSize = select(isTokens, tokenSize, gaiaSize);
    
    const instanceSize = mix(float(0.8), float(3.0), zoomT).mul(computedSize);
    
    const isVisible = rawMag.greaterThan(0.0)
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
    const age = time.sub(spawnTime);
    const fadeAlpha = smoothstep(0.0, 0.3, age);
    
    const shouldDiscard = distanceToCenter.greaterThan(0.5).or(isSubPixelOpacity.and(probDiscard));
    const safeAlpha = select(shouldDiscard, float(0.0), max(finalAlpha, threshold).mul(fadeAlpha));

    mat.colorNode = baseColor.mul(safeAlpha);
    mat.opacityNode = safeAlpha;
    
    const offset3D = vec3(offsetX, offsetY, float(0.0));
    mat.positionNode = select(isVisible, offset3D.add(positionLocal.mul(safeSize)), vec3(1000000.0));

    return mat;
  }

  private createPickingMaterial() {
    const rawMag = attribute('instanceSize', 'float');
    const offsetX = attribute('offsetX', 'float');
    const offsetY = attribute('offsetY', 'float');
    const pointIx = attribute('pointIx', 'float');

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
    
    // TSL native userData pulls slotIndex dynamically without material clones
    const slotIndexNode = userData('slotIndex', 'uint');
    const globalInstanceIndex = slotIndexNode.mul(this.rowsPerTile).add(uint(instanceIndex));
    const fInstanceIndex = globalInstanceIndex.add(0x01000000);
    
    const r = float(fInstanceIndex.bitAnd(0xFF)).div(255.0);
    const g = float(fInstanceIndex.shiftRight(8).bitAnd(0xFF)).div(255.0);
    const b = float(fInstanceIndex.shiftRight(16).bitAnd(0xFF)).div(255.0);
    const a = float(fInstanceIndex.shiftRight(24).bitAnd(0xFF)).div(255.0);
    
    mat.colorNode = vec3(r, g, b);
    
    const isVisible = rawMag.greaterThan(0.0)
                      .and(pointIx.lessThanEqual(this.maxIxUniform));
    const distanceToCenter = distance(uv(), vec2(0.5));
    const shouldDiscard = distanceToCenter.greaterThan(0.5).or(isVisible.not());
    mat.opacityNode = select(shouldDiscard, float(0.0), a);
    
    const zoomT = this.rendererWrapper.zoomTUniform;
    const targetPixels = mix(float(1.0), float(2.0), zoomT);
    const instanceSize = mix(float(0.8), float(3.0), zoomT).mul(rawMag);
    const safeSize = targetPixels.mul(this.rendererWrapper.worldUnitsPerPixelUniform).mul(instanceSize);

    const offset3D = vec3(offsetX, offsetY, float(0.0));
    mat.positionNode = select(isVisible, offset3D.add(positionLocal.mul(safeSize)), vec3(1000000.0));

    return mat;
  }

  public calculateMaxIx(camera: THREE.OrthographicCamera): number {
    const visibleWidth = (camera.right - camera.left) / camera.zoom;
    const visibleHeight = (camera.top - camera.bottom) / camera.zoom;
    const visibleArea = visibleWidth * visibleHeight;
    const safeRootArea = this.rootArea > 0 ? this.rootArea : 1;
    const areaRatio = safeRootArea / visibleArea;
    return 3000000 * areaRatio;
  }

  public updateCamera(camera: THREE.Camera) {
    const vp = new THREE.Matrix4();
    vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.vpMatrixUniform.value.copy(vp);
    
    // Dynamic Density Culling (Progressive Subsampling)
    const orthoCam = camera as THREE.OrthographicCamera;
    const currentZoom = Math.log2(Math.max(1.0, camera.zoom));
    const zoomT = Math.max(0.0, Math.min(1.0, currentZoom / 6.0));
    
    this.maxIxUniform.value = this.calculateMaxIx(orthoCam);
  }

    private getFreeSlot(): number {
      for (let i = 0; i < this.maxTiles; i++) {
          if (this.slotToTileKey[i] === '') return i;
      }
      return -1;
    }

    private globalZeroBuffer: ArrayBuffer = new Float32Array(this.rowsPerTile).buffer;

    public unloadTile(key: string) {
        const slot = this.tileKeyToSlot.get(key);
        if (slot !== undefined) {
            this.slotToTileKey[slot] = '';
            this.slotToTileData[slot] = null;
            this.tileKeyToSlot.delete(key);
            this.slotMeshes[slot].visible = false;
        }
    }

    public updateTiles(tiles: TileData[]) {
        const currentKeys = new Set(tiles.map(t => t.key));
        
        // PCIe Throttling: Lower max updates to prevent 30MB bandwidth spikes during fast panning
        const MAX_PROCESS_TILES = 4; 
        let processedTiles = 0;

        // 1. Identify tiles that are currently on GPU but no longer active
        for (const [key, slot] of this.tileKeyToSlot.entries()) {
            if (!currentKeys.has(key)) {
                this.unloadTile(key);
            }
        }
        
        // Ensure only currently visible tiles are drawn! (Zero-Cost Culling)
        for (let i = 0; i < this.maxTiles; i++) {
            this.slotMeshes[i].visible = false;
        }

    // 2. Process added/updated tiles
    for (const tile of tiles) {
      if (!this.tileKeyToSlot.has(tile.key)) {
        const slot = this.getFreeSlot();
        if (slot === -1) continue; // Out of slots (exceeds maxTiles)
        
        this.tileKeyToSlot.set(tile.key, slot);
        this.slotToTileKey[slot] = tile.key;
        this.slotToTileData[slot] = tile;
        tile.needsUpdate = true;
        
        // Prevent drawing garbage from a previous tile in this slot
        const geo = this.slotMeshes[slot].geometry as THREE.InstancedBufferGeometry;
        geo.instanceCount = 0;
      }
      
      const slot = this.tileKeyToSlot.get(tile.key)!;
      const geo = this.slotMeshes[slot].geometry as THREE.InstancedBufferGeometry;

      if (tile.needsUpdate) {
        if (processedTiles >= MAX_PROCESS_TILES) {
             this.slotMeshes[slot].visible = geo.instanceCount > 0;
             continue;
        }
        processedTiles++;
        
        geo.instanceCount = tile.numRows;
        
        if (tile.xBuffer) {
            (geo.attributes.offsetX.array as Float32Array).set(new Float32Array(tile.xBuffer));
            geo.attributes.offsetX.needsUpdate = true;

            (geo.attributes.offsetY.array as Float32Array).set(new Float32Array(tile.yBuffer!));
            geo.attributes.offsetY.needsUpdate = true;

            const ixBuf = tile.ixBuffer || new Float32Array(tile.numRows).buffer;
            (geo.attributes.pointIx.array as Float32Array).set(new Float32Array(ixBuf));
            geo.attributes.pointIx.needsUpdate = true;
        }
        
        if (tile.colorBuffer) {
            const currentTime = performance.now() / 1000.0;
            const spawnTimeArray = new Float32Array(tile.numRows).fill(currentTime);

            (geo.attributes.instanceColor.array as Float32Array).set(new Float32Array(tile.colorBuffer));
            geo.attributes.instanceColor.needsUpdate = true;

            (geo.attributes.instanceSize.array as Float32Array).set(new Float32Array(tile.sizeBuffer!));
            geo.attributes.instanceSize.needsUpdate = true;

            (geo.attributes.spawnTime.array as Float32Array).set(spawnTimeArray);
            geo.attributes.spawnTime.needsUpdate = true;
        }
        
        if (tile.hoverBuffer) {
            const offset = slot * this.rowsPerTile;
            this.globalHoverBuffer.set(new Int32Array(tile.hoverBuffer), offset * 3);
        }

        tile.needsUpdate = false;
      }
      
      this.slotMeshes[slot].visible = geo.instanceCount > 0;
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
  
      const tile = this.slotToTileData[slotIndex];
      if (!tile || !tile.xBuffer || !tile.yBuffer || !tile.sizeBuffer) {
          this.hoverMesh.visible = false;
          return;
      }

      const offsetX = new Float32Array(tile.xBuffer);
      const offsetY = new Float32Array(tile.yBuffer);
      const sizeBuffer = new Float32Array(tile.sizeBuffer);
      
      const x = offsetX[rowIndex];
      const y = offsetY[rowIndex];
      this.hoverMesh.position.set(x, y, 0.0);
      
      // Sync hover scale precisely with the visual shader scale
      const currentZoom = Math.log2(Math.max(1.0, this.rendererWrapper.camera.zoom));
      const zoomT = Math.max(0, Math.min(1.0, currentZoom / 6.0));
      const targetPixels = 1.0 * (1.0 - zoomT) + 2.0 * zoomT;
      const baseInstanceSize = 0.8 * (1.0 - zoomT) + 3.0 * zoomT;
      const rawMag = sizeBuffer[rowIndex];
      
      let computedSize = 0;
      if (rawMag > 30.0) {
          computedSize = Math.max(0.5, Math.log2(Math.max(rawMag, 1.0)));
      } else {
          computedSize = Math.max(0.05, (21.0 - rawMag) / 10.0);
      }
      
      const physicalSize = targetPixels * baseInstanceSize * computedSize * this.rendererWrapper.worldUnitsPerPixelUniform.value * 4.0;
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
