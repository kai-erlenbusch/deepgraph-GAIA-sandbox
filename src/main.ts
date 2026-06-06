import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { 
  attribute, float, positionLocal, vec3, vec2, uv, distance, smoothstep,
  fwidth, hash, instanceIndex, Discard, max, min, userData, uint, mix,
  log2, clamp, pow, uniformArray, uniform, select, varying
} from 'three/tsl';
import { Renderer } from './core/Renderer';
import { TileManager, BoundingBox, TileData } from './data/TileManager';

const TILE_SERVER_URL = '/data';

// --- Shader-Side Color Palettes ---
const warmPaletteColors = ['#ffeda0', '#feb24c', '#f03b20', '#bcbddc', '#756bb1'];
const coolPaletteColors = ['#f1eef6', '#bdc9e1', '#74a9cf', '#2b8cbe', '#045a8d'];

let isWarmPalette = true;

// Create a dedicated array of THREE.Color objects for the uniform
const activePalette = warmPaletteColors.map(c => new THREE.Color(c));

// We define the uniform array node so TSL can mathematically index into it
const paletteUniform = uniformArray(activePalette);

(window as any).swapPalette = () => {
  isWarmPalette = !isWarmPalette;
  const newColors = isWarmPalette ? warmPaletteColors : coolPaletteColors;
  // Update the underlying THREE.Color objects inside the uniform node
  for (let i = 0; i < 5; i++) {
    (paletteUniform.array as THREE.Color[])[i].set(newColors[i]);
  }
  const btn = document.getElementById('swap-palette-btn');
  if (btn) {
    btn.innerText = `Swap Palette (${isWarmPalette ? 'Warm' : 'Cool'})`;
  }
};


class Scatterplot {
  private scene: THREE.Scene;
  private material: MeshBasicNodeMaterial;
  private tileMeshes: Map<string, THREE.Mesh> = new Map();
  private quadGeometry = new THREE.PlaneGeometry(1, 1);

  private pickingScene: THREE.Scene;
  private pickingMaterial: MeshBasicNodeMaterial;
  private pickingMeshes: Map<string, THREE.Mesh> = new Map();
  private globalPickingId = 1; // start at 1, since 0 is background
  public pickingMap: Map<number, { tileKey: string, rowIndex: number }> = new Map();
  
  public hoverMesh: THREE.Mesh;
  public hoverColorUniform: any;

  constructor(scene: THREE.Scene, rendererWrapper: Renderer) {
    this.scene = scene;
    
    this.material = new MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor, // Pre-multiplying in shader
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendEquation: THREE.AddEquation,
    });

    // Mathematically perfect continuous Zoom Level calculation
    // Assumes base extent (Zoom 0) has worldUnitsPerPixel roughly equal to 0.04
    // Unclamped so currentZoom can be negative when zooming WAY far back!
    const currentZoom = log2(float(0.04).div(rendererWrapper.worldUnitsPerPixelUniform));
    
    // Map continuous zoom to a 0.0 to 1.0 interpolation factor (capping at Zoom 6)
    // We max(0) the zoom ONLY for the size curve so points don't shrink below 1.2px
    const zoomT = clamp(max(float(0.0), currentZoom).div(float(6.0)), 0.0, 1.0);

    // Dynamic Size Curve
    // Smoothly interpolate size from 1.2px at Zoom 0 to 4.0px at Zoom 6
    const targetPixels = mix(float(1.2), float(4.0), zoomT); 
    const size = targetPixels.mul(rendererWrapper.worldUnitsPerPixelUniform);
    
    // Calculate distance from the quad's center (0.5, 0.5)
    const dist = distance(uv(), vec2(0.5));
    
    // Deepscatter Stochastic Discard Logic
    // Dynamically reads the physical density of the current tile from CPU!
    // Zoom-based Dynamic Opacity
    // To combat single-pass additive blowout, we reduce opacity exponentially as we zoom out
    const baseOpacity = float(0.15); // max opacity at Zoom 0
    const negativeDecay = pow(float(2.0), min(float(0.0), currentZoom));
    const dynamicOpacity = baseOpacity.mul(negativeDecay);
    
    // "Elite Memory Trick": Shader-Side Color Palette
    const baseColorAttribute = attribute('instanceColor', 'vec4');
    const rawByteValueFloat = baseColorAttribute.r.mul(255.0);
    const colorIndexFloat = rawByteValueFloat.mod(5.0);
    const colorIndex = uint(colorIndexFloat);
    const paletteColor = paletteUniform.element(colorIndex);

    // --- VERTEX SHADER STAGE ---
    const threshold = float(1.0 / 255.0);
    
    // Vertex Culling: if it's completely invisible, collapse the vertex to save the rasterizer
    const culledSize = select(dynamicOpacity.lessThan(threshold), float(0.0), size);
    
    // --- FRAGMENT SHADER STAGE ---
    // Edge Softening (Combined with Hardware Anti-Aliasing)
    const delta = fwidth(dist);
    const sharpInnerEdge = float(0.5).sub(delta);
    const sharpOuterEdge = float(0.5).add(delta);
    
    // GLSL smoothstep(edge0, edge1, x) is UNDEFINED if edge0 >= edge1 and can crash the GPU!
    // Always use sharpInnerEdge < sharpOuterEdge, and subtract from 1.0 to invert the mask.
    const alphaEdge = float(1.0).sub(smoothstep(sharpInnerEdge, max(sharpOuterEdge, sharpInnerEdge.add(float(0.001))), dist));
    
    const finalAlpha = alphaEdge.mul(dynamicOpacity);
    
    // Stochastic Sub-pixel Dithering
    const randomVal = hash(instanceIndex).mul(float(255.0));
    const isSubPixelOpacity = finalAlpha.lessThan(threshold);
    const probDiscard = randomVal.greaterThan(finalAlpha.mul(float(255.0)));
    
    Discard(isSubPixelOpacity.and(probDiscard));
    
    const safeAlpha = max(finalAlpha, threshold);
    
    this.material.colorNode = paletteColor.mul(safeAlpha);
    this.material.opacityNode = safeAlpha;
    
    // World position: instance offset + local vertex position * culledSize
    // 1. Define how far apart the layers should be (e.g., 2.0 World Units)
    const layerSpacingUniform = uniform(float(2.0));
    // 2. Extrude the Z-axis based on the category color index (0 through 4)
    // This will stack the colors like 5 panes of glass
    const zDepth = float(colorIndex).mul(layerSpacingUniform);
    // 3. Apply it to the 3D offset!
    const offset2D = attribute('offset', 'vec2');
    const offset3D = vec3(offset2D.x, offset2D.y, zDepth);
    
    this.material.positionNode = offset3D.add(positionLocal.mul(culledSize));

    // Picking Setup
    this.pickingScene = new THREE.Scene();
    this.pickingScene.background = new THREE.Color(0x000000); // 0 is null id
    this.pickingMaterial = new MeshBasicNodeMaterial({
      depthWrite: false,
      blending: THREE.NoBlending,
    });
    
    // Mathematically derive unique RGB picking color on the GPU
    const tileStartId = userData('tileStartId', 'uint');
    const globalId = tileStartId.add(uint(instanceIndex));
    
    const r = globalId.shiftRight(16).bitAnd(255);
    const g = globalId.shiftRight(8).bitAnd(255);
    const b = globalId.bitAnd(255);
    
    this.pickingMaterial.colorNode = vec3(float(r), float(g), float(b)).div(255.0);
    
    // Fat Pointers for Picking (2.0x size) using the identical zDepth extrusion!
    const pickingSize = culledSize.mul(float(2.0));
    this.pickingMaterial.positionNode = offset3D.add(positionLocal.mul(pickingSize));
    
    // Create Ghost Mesh for UI Hover
    // We create a normalized PlaneGeometry to use custom TSL UV distance math
    this.hoverColorUniform = uniform(new THREE.Color(0xffffff));
    const hoverGeo = new THREE.PlaneGeometry(1, 1);
    const hoverMat = new MeshBasicNodeMaterial({ 
      transparent: true, 
      depthTest: false, // Render on top of everything
      blending: THREE.NormalBlending // Explicitly Normal Blending for true black borders!
    });
    
    // TSL Math: Draw a circle with a dark border
    const d = distance(uv(), vec2(0.5));
    const isBorder = d.greaterThan(0.35);
    const finalColor = select(isBorder, vec3(0.0, 0.0, 0.0), this.hoverColorUniform);
    hoverMat.colorNode = finalColor;
    hoverMat.opacityNode = select(d.lessThan(0.5), float(1.0), float(0.0));
    
    this.hoverMesh = new THREE.Mesh(hoverGeo, hoverMat);
    this.hoverMesh.visible = false;
    this.scene.add(this.hoverMesh);
  }

  public updateTiles(tiles: TileData[]) {
    // Determine which tiles are no longer needed
    const currentKeys = new Set(tiles.map(t => t.key));
    for (const [key, mesh] of this.tileMeshes.entries()) {
      if (!currentKeys.has(key)) {
        this.scene.remove(mesh);
        mesh.geometry.dispose();
        this.tileMeshes.delete(key);
        
        const pickingMesh = this.pickingMeshes.get(key);
        if (pickingMesh) {
          this.pickingScene.remove(pickingMesh);
          this.pickingMeshes.delete(key);
        }
      }
    }

    // Add new tiles
    for (const tile of tiles) {
      if (!this.tileMeshes.has(tile.key)) {
        this.addTile(tile);
      }
    }
  }

  private addTile(tile: TileData) {
    const instancedGeometry = new THREE.InstancedBufferGeometry();
    instancedGeometry.index = this.quadGeometry.index;
    instancedGeometry.instanceCount = tile.numRows;
    instancedGeometry.attributes.position = this.quadGeometry.attributes.position;
    instancedGeometry.attributes.uv = this.quadGeometry.attributes.uv;

    // INTERLEAVED BUFFER (16 bytes per point)
    const bufferF32 = new THREE.InstancedInterleavedBuffer(new Float32Array(tile.interleavedBuffer), 4);
    const bufferU8 = new THREE.InstancedInterleavedBuffer(new Uint8Array(tile.interleavedBuffer), 16);

    // Map the views to the shader attributes. 
    // We intentionally ignore bytes 8-11 (formerly instanceSize) to maintain a fast 16-byte power-of-two stride,
    // while forcing all points to a microscopic 1.4 physical pixels in the shader.
    instancedGeometry.setAttribute('offset', new THREE.InterleavedBufferAttribute(bufferF32, 2, 0));
    instancedGeometry.setAttribute('instanceColor', new THREE.InterleavedBufferAttribute(bufferU8, 4, 12, true));

    const startId = this.globalPickingId;
    this.globalPickingId += tile.numRows;

    const mesh = new THREE.Mesh(instancedGeometry, this.material);
    mesh.frustumCulled = false; // We handle culling manually via TileManager
    
    // Calculate physical density and pass to the shader via userData
    // TileData doesn't have bounds, but we can calculate exact area from Z index!
    const [z] = tile.key.split('/').map(Number);
    const rootArea = 40.2228 * 40.2228; // Extracted from root bounds
    const area = rootArea / Math.pow(4, z);
    mesh.userData.density = tile.numRows / area;
    
    this.scene.add(mesh);
    this.tileMeshes.set(tile.key, mesh);

    const pickingMesh = new THREE.Mesh(instancedGeometry, this.pickingMaterial);
    pickingMesh.frustumCulled = false;
    pickingMesh.userData.tileStartId = startId;
    this.pickingScene.add(pickingMesh);
    this.pickingMeshes.set(tile.key, pickingMesh);
    
    for (let i = 0; i < tile.numRows; i++) {
      this.pickingMap.set(startId + i, { tileKey: tile.key, rowIndex: i });
    }
  }

  public getPickingScene() {
    return this.pickingScene;
  }

  public updateHover(id: number) {
    if (id === 0) {
      this.hoverMesh.visible = false;
      return;
    }
    const data = this.pickingMap.get(id);
    if (!data) return;
    const mesh = this.tileMeshes.get(data.tileKey);
    if (!mesh) return;

    // The interleaved buffer contains 4 floats (16 bytes) per instance.
    const bufferF32 = mesh.geometry.attributes.offset.data.array as Float32Array;
    const bufferU8 = mesh.geometry.attributes.instanceColor.data.array as Uint8Array;
    
    const row = data.rowIndex;
    // float offset is 4 elements per row (x, y, null, null)
    const x = bufferF32[row * 4 + 0];
    const y = bufferF32[row * 4 + 1];
    
    // byte offset is 16 elements per row, color starts at byte 12
    const r = bufferU8[row * 16 + 12];
    const colorIndex = r % 5;
    // 2.0 spacing perfectly matches our shader extrusion layerSpacingUniform!
    const zDepth = colorIndex * 2.0;

    // Sync Ghost Mesh color to the actual palette!
    const activePalette = isWarmPalette ? warmPaletteColors : coolPaletteColors;
    this.hoverColorUniform.value.set(activePalette[colorIndex]);

    this.hoverMesh.position.set(x, y, zDepth + 0.01);
    this.hoverMesh.visible = true;
  }
}

async function init() {
  const container = document.getElementById('app')!;
  const uiText = document.querySelector('#ui p')!;

  if (!navigator.gpu) {
    uiText.textContent = 'WebGPU is not supported by your browser.';
    return;
  }

  const rendererWrapper = new Renderer(container);
  await rendererWrapper.init();

  // Real LMSys dataset bounds calculated by build_quadtree.py
  const rootBounds: BoundingBox = { 
    minX: -13.004743576049805, 
    maxX: 27.21806526184082, 
    minY: -18.281795501708984, 
    maxY: 21.94101333618164 
  };
  const tileManager = new TileManager(TILE_SERVER_URL, rootBounds);
  
  uiText.innerHTML = `WebGPU is supported!<br/>Streaming Quadtree Tiles...`;

  const scatterplot = new Scatterplot(rendererWrapper.scene, rendererWrapper);

  const pickingTexture = new THREE.RenderTarget(window.innerWidth, window.innerHeight, {
    colorSpace: THREE.NoColorSpace
  });
  window.addEventListener('resize', () => {
    pickingTexture.setSize(window.innerWidth, window.innerHeight);
  });

  const mouse = new THREE.Vector2();
  let mouseMoved = false;

  window.addEventListener('mousemove', (e) => {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
    mouseMoved = true;
  });

  const tooltip = document.createElement('div');
  tooltip.style.position = 'absolute';
  tooltip.style.background = 'rgba(0,0,0,0.8)';
  tooltip.style.color = 'white';
  tooltip.style.padding = '5px';
  tooltip.style.borderRadius = '5px';
  tooltip.style.display = 'none';
  tooltip.style.pointerEvents = 'none';
  tooltip.style.zIndex = '1000';
  document.body.appendChild(tooltip);

  rendererWrapper.renderer.setAnimationLoop(async () => {
    try {
      // 1. Get viewport bounds
      const bounds = rendererWrapper.getViewportBounds();
      const zoomLevel = Math.max(0, Math.floor(Math.log2(rendererWrapper.camera.zoom)));
      
      // 2. Fetch visible tiles
      const visibleTiles = await tileManager.getVisibleTiles(bounds, zoomLevel);
      
      // 3. Update scatterplot geometry
      scatterplot.updateTiles(visibleTiles);
      
      let totalPoints = 0;
      for (const t of visibleTiles) totalPoints += t.numRows;
      uiText.innerHTML = `Streaming Quadtree<br/>Tiles rendered: ${visibleTiles.length}<br/>Points: ${totalPoints}<br/>Zoom Level: ${zoomLevel}`;

      // 4. Render
      rendererWrapper.render();
      
      // Deepscatter Magnification: Base size * 4.0x
      const magnifiedSize = 3.0 * 4.0; 
      scatterplot.hoverMesh.scale.setScalar(rendererWrapper.worldUnitsPerPixelUniform.value * magnifiedSize);

      // 5. Picking Pass
      if (mouseMoved) {
        mouseMoved = false;
        
        rendererWrapper.renderer.setRenderTarget(pickingTexture);
        rendererWrapper.renderer.render(scatterplot.getPickingScene(), rendererWrapper.camera);
        rendererWrapper.renderer.setRenderTarget(null);
        
        // WebGPU render targets use a Top-Left origin (0,0 is top-left), exactly matching the mouse!
        const pickY = mouse.y;
        const pixelBuffer = await rendererWrapper.renderer.readRenderTargetPixelsAsync(pickingTexture, mouse.x, pickY, 1, 1);
        
        const id = (pixelBuffer[0] << 16) | (pixelBuffer[1] << 8) | pixelBuffer[2];
        if (id > 0 && scatterplot.pickingMap.has(id)) {
          scatterplot.updateHover(id);
          const data = scatterplot.pickingMap.get(id)!;
          tooltip.style.display = 'block';
          tooltip.style.left = mouse.x + 15 + 'px';
          tooltip.style.top = mouse.y + 15 + 'px';
          tooltip.style.fontFamily = 'monospace';
          tooltip.innerHTML = `Tile: ${data.tileKey}<br/>Row: ${data.rowIndex}<br/>Global ID: ${id}`;
        } else {
          scatterplot.updateHover(0);
          tooltip.style.display = 'none';
        }
      }
    } catch (err) {
      console.error("Animation loop crash:", err);
      rendererWrapper.renderer.setAnimationLoop(null); // Stop loop to avoid 3000 errors
    }
  });
}

init().catch(console.error);
