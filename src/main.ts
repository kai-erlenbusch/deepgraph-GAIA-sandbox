import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { 
  attribute, float, positionLocal, vec3, vec2, uv, distance, smoothstep,
  fwidth, hash, instanceIndex, Discard, max, min, userData, uint, mix,
  log2, clamp, pow, uniformArray, uniform, select
} from 'three/tsl';
import { Renderer } from './core/Renderer';
import { TileManager, BoundingBox, TileData } from './data/TileManager';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

// --- ON-SCREEN DEBUGGER ---
const debugDiv = document.createElement('div');
debugDiv.style.position = 'absolute';
debugDiv.style.bottom = '10px';
debugDiv.style.left = '10px';
debugDiv.style.width = '600px';
debugDiv.style.height = '300px';
debugDiv.style.overflowY = 'auto';
debugDiv.style.backgroundColor = 'rgba(0,0,0,0.8)';
debugDiv.style.color = '#00ff00';
debugDiv.style.fontFamily = 'monospace';
debugDiv.style.fontSize = '12px';
debugDiv.style.padding = '10px';
debugDiv.style.pointerEvents = 'none';
debugDiv.style.zIndex = '9999';
document.body.appendChild(debugDiv);

const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;

function logToScreen(msg: string, color: string) {
  const line = document.createElement('div');
  line.style.color = color;
  line.innerText = msg;
  debugDiv.appendChild(line);
  debugDiv.scrollTop = debugDiv.scrollHeight;
}

console.log = (...args) => {
  originalLog(...args);
  logToScreen(args.map(a => String(a)).join(' '), '#00ff00');
};
console.warn = (...args) => {
  originalWarn(...args);
  logToScreen(args.map(a => String(a)).join(' '), '#ffff00');
};
console.error = (...args) => {
  originalError(...args);
  logToScreen(args.map(a => String(a)).join(' '), '#ff0000');
};
// --------------------------

const TILE_SERVER_URL = '/tiles';

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

let is2DMode = false;
let rendererInstance: Renderer | null = null;
let scatterplotInstance: Scatterplot | null = null;

(window as any).swapMode = () => {
  is2DMode = !is2DMode;
  if (scatterplotInstance) {
    // 0.0 perfectly flattens the points. 1.0 extrudes them based on real Z-topo.
    scatterplotInstance.layerSpacingUniform.value = is2DMode ? 0.0 : 1.0;
  }
  if (rendererInstance) {
    rendererInstance.set2DMode(is2DMode);
  }
  
  const btn = document.getElementById('swap-mode-btn');
  if (btn) {
    btn.innerText = `Mode: ${is2DMode ? '2D' : '2.5D'}`;
  }
};

class Scatterplot {
  private scene: THREE.Scene;
  private material: MeshBasicNodeMaterial;
  private tileMeshes: Map<string, THREE.Mesh> = new Map();
  private quadGeometry = new THREE.PlaneGeometry(1, 1);

  private pickingScene: THREE.Scene;
  private pickingMaterial: MeshBasicNodeMaterial;
  public hoverMesh: THREE.Mesh;
  public hoverColorUniform: any;
  public layerSpacingUniform = uniform(1.0); // Default 2.5D mode is 1.0 multiplier

  constructor(scene: THREE.Scene, rendererWrapper: Renderer) {
    this.scene = scene;
    
    this.material = new MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor, // Pre-multiplying in shader
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendEquation: THREE.AddEquation,
      side: THREE.DoubleSide // Allow viewing from behind!
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
    const instanceSize = attribute('instanceSize', 'float');
    const size = targetPixels.mul(rendererWrapper.worldUnitsPerPixelUniform).mul(instanceSize);
    
    // Calculate distance from the quad's center (0.5, 0.5)
    const dist = distance(uv(), vec2(0.5));
    
    // Deepscatter Stochastic Discard Logic
    // Dynamically reads the physical density of the current tile from CPU!
    // Zoom-based Dynamic Opacity
    // To combat single-pass additive blowout, we reduce opacity exponentially as we zoom out
    const tileDensity = userData('density', 'float');
    const baseOpacity = float(0.15); // max opacity at Zoom 0
    const negativeDecay = pow(float(2.0), min(float(0.0), currentZoom));
    // Divide opacity by physical density to normalize dense vs sparse tiles. Multiply by scalar to keep it visible.
    const dynamicOpacity = baseOpacity.mul(negativeDecay).div(max(tileDensity, float(0.0001))).mul(float(100.0));
    
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
    // We multiply delta by 0.5 to force the edge blend to exactly 1 screen pixel (ultra-crisp)
    const delta = fwidth(dist).mul(0.5);
    const sharpInnerEdge = float(0.5).sub(delta);
    const sharpOuterEdge = float(0.5).add(delta);
    
    // GLSL smoothstep(edge0, edge1, x) is UNDEFINED if edge0 >= edge1 and can crash the GPU!
    // Always use sharpInnerEdge < sharpOuterEdge, and subtract from 1.0 to invert the mask.
    const alphaEdge = float(1.0).sub(smoothstep(sharpInnerEdge, max(sharpOuterEdge, sharpInnerEdge.add(float(0.001))), dist));
    
    // Sub-pixel hardware anti-aliasing crash prevention
    // targetPixels is the actual size in screen pixels. Compare that to 1.0!
    const sizeInPixels = targetPixels.mul(instanceSize);
    const isSubPixel = sizeInPixels.lessThan(float(1.0));
    const finalAlpha = select(isSubPixel, dynamicOpacity, alphaEdge.mul(dynamicOpacity));
    
    // Stochastic Sub-pixel Dithering
    const randomVal = hash(instanceIndex).mul(float(255.0));
    const isSubPixelOpacity = finalAlpha.lessThan(threshold);
    const probDiscard = randomVal.greaterThan(finalAlpha.mul(float(255.0)));
    
    // Instead of TSL Discard (which gets optimized out), we explicitly set alpha to 0.0!
    // We discard if it's the empty corner (dist > 0.5) OR if stochastic dithering failed!
    const shouldDiscard = dist.greaterThan(0.5).or(isSubPixelOpacity.and(probDiscard));
    
    const safeAlpha = select(shouldDiscard, float(0.0), max(finalAlpha, threshold));
    
    this.material.colorNode = paletteColor.mul(safeAlpha);
    this.material.opacityNode = safeAlpha;
    
    // World position: instance offset + local vertex position * culledSize
    const offset3DAttr = attribute('offset', 'vec3'); // Now it has X, Y, Z directly from geomBuffer
    
    // Extrude the Z-axis based on the continuous physical Topo Z mapping
    const finalZ = offset3DAttr.z.mul(this.layerSpacingUniform);
    const offset3D = vec3(offset3DAttr.x, offset3DAttr.y, finalZ);
    
    this.material.positionNode = offset3D.add(positionLocal.mul(culledSize));

    // WebGPU Picking Material completely removed in favor of CPU Raycasting!
    
    // Create Ghost Mesh for UI Hover
    // We create a normalized PlaneGeometry to use custom TSL UV distance math
    this.hoverColorUniform = uniform(new THREE.Color(0xffffff));
    const hoverGeo = new THREE.PlaneGeometry(1, 1);
    const hoverMat = new MeshBasicNodeMaterial({ 
      transparent: true, 
      depthTest: false, // Render on top of everything
      blending: THREE.NormalBlending, // Explicitly Normal Blending for true black borders!
      side: THREE.DoubleSide // Allow viewing from behind!
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
        mesh.userData.hoverBuffer = null;
        this.tileMeshes.delete(key);
      }
    }

    // Check if any existing tiles need semantic updates
    for (const tile of tiles) {
      if (tile.needsUpdate) {
        const mesh = this.tileMeshes.get(tile.key);
        if (mesh && tile.colorBuffer && tile.sizeBuffer) {
          const colorAttr = mesh.geometry.attributes.instanceColor as THREE.InstancedBufferAttribute;
          colorAttr.array.set(new Uint8Array(tile.colorBuffer));
          colorAttr.needsUpdate = true;
          
          const sizeAttr = mesh.geometry.attributes.instanceSize as THREE.InstancedBufferAttribute;
          sizeAttr.array.set(new Float32Array(tile.sizeBuffer));
          sizeAttr.needsUpdate = true;
          
          mesh.userData.hoverBuffer = new Int32Array(tile.hoverBuffer!);
        }
        tile.needsUpdate = false;
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

    // 1. GEOMETRY BUFFER (12 bytes per point)
    const geomBuffer = new THREE.InstancedInterleavedBuffer(new Float32Array(tile.geomBuffer!), 3);
    instancedGeometry.setAttribute('offset', new THREE.InterleavedBufferAttribute(geomBuffer, 3, 0));

    // 2. DUMMY SEMANTIC BUFFERS (Pre-allocated for WebGPU compilation!)
    const colorArray = new Uint8Array(tile.colorBuffer || new ArrayBuffer(tile.numRows * 4));
    if (!tile.colorBuffer) {
        for(let i=0; i<tile.numRows; i++) {
           colorArray[i*4+0] = 128; // gray fallback
           colorArray[i*4+1] = 128;
           colorArray[i*4+2] = 128;
           colorArray[i*4+3] = 255;
        }
    }
    instancedGeometry.setAttribute('instanceColor', new THREE.InstancedBufferAttribute(colorArray, 4, true));

    const sizeArray = new Float32Array(tile.sizeBuffer || new ArrayBuffer(tile.numRows * 4));
    if (!tile.sizeBuffer) {
        for(let i=0; i<tile.numRows; i++) sizeArray[i] = 1.0; // fallback size
    }
    instancedGeometry.setAttribute('instanceSize', new THREE.InstancedBufferAttribute(sizeArray, 1));

    const mesh = new THREE.Mesh(instancedGeometry, this.material);
    mesh.frustumCulled = false; // We handle culling manually via TileManager
    
    // Calculate physical density and pass to the shader via userData
    // TileData doesn't have bounds, but we can calculate exact area from Z index!
    const [z] = tile.key.split('/').map(Number);
    const rootArea = 40.14673 * 40.30325; // Extracted from root bounds
    const area = rootArea / Math.pow(4, z);
    mesh.userData.density = tile.numRows / area;
    
    mesh.userData.hoverBuffer = tile.hoverBuffer ? new Int32Array(tile.hoverBuffer) : null;
    
    this.scene.add(mesh);
    this.tileMeshes.set(tile.key, mesh);
  }

  public updateHover(tileKey: string, rowIndex: number, tooltipHtmlCallback: (html: string) => void) {
    if (tileKey === "") {
      this.hoverMesh.visible = false;
      return;
    }
    const mesh = this.tileMeshes.get(tileKey);
    if (!mesh) return;

    const bufferF32 = (mesh.geometry.attributes.offset as THREE.InterleavedBufferAttribute).data.array as Float32Array;
    const bufferU8 = (mesh.geometry.attributes.instanceColor as THREE.InstancedBufferAttribute).array as Uint8Array;
    
    const row = rowIndex;
    const x = bufferF32[row * 3 + 0];
    const y = bufferF32[row * 3 + 1];
    const z = bufferF32[row * 3 + 2];
    
    const r = bufferU8[row * 4 + 0];
    const colorIndex = r % 5;
    
    // Extrude based on topo z mapping. 
    // We do NOT add +0.01 to zDepth because it causes perspective skew. 
    // depthTest: false already guarantees it draws on top!
    const zDepth = z * (this.layerSpacingUniform.value as number);

    // Sync Ghost Mesh color to the actual palette!
    const activePalette = isWarmPalette ? warmPaletteColors : coolPaletteColors;
    this.hoverColorUniform.value.set(activePalette[colorIndex]);

    this.hoverMesh.position.set(x, y, zDepth);
    
    // Calculate the exact world size of the dot so the Ghost Mesh wraps it perfectly
    const worldUnitsPerPixel = rendererInstance!.worldUnitsPerPixelUniform.value as number;
    const currentZoom = Math.log2(0.04 / worldUnitsPerPixel);
    const zoomT = Math.max(0, Math.min(1, Math.max(0, currentZoom) / 6.0));
    const targetPixels = 1.2 * (1 - zoomT) + 4.0 * zoomT;
    
    let instanceSize = 1.0;
    if (mesh.geometry.attributes.instanceSize) {
      const sizeAttr = (mesh.geometry.attributes.instanceSize as THREE.InstancedBufferAttribute).array as Float32Array;
      instanceSize = sizeAttr[row];
    }
    
    // Scale by 4.0x to create a massive "Magnification" hover effect!
    const physicalSize = targetPixels * instanceSize * worldUnitsPerPixel * 4.0;
    this.hoverMesh.scale.set(physicalSize, physicalSize, 1.0);
    
    this.hoverMesh.visible = true;
    
    let hoverText = `Tile: ${tileKey}<br/>Row: ${rowIndex}`;
    if (mesh.userData.hoverBuffer) {
       const hb = mesh.userData.hoverBuffer as Int32Array;
       const global_id = hb[row * 3 + 0];
       const model_id = hb[row * 3 + 1];
       const num_of_tokens = hb[row * 3 + 2];
       hoverText = `Global ID: ${global_id}<br/>Model ID: ${model_id}<br/>Tokens: ${num_of_tokens}`;
    } else {
       hoverText += `<br/><i>Loading semantic data...</i>`;
    }
    tooltipHtmlCallback(hoverText);
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

  // Dynamically fetch dataset boundaries!
  let rootBounds: BoundingBox;
  let validTiles = new Set<string>();
  try {
    const res = await fetch(`${TILE_SERVER_URL}/index.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const indexData = await res.json();
    rootBounds = { 
      minX: indexData.global_bounds.min_x, 
      maxX: indexData.global_bounds.max_x, 
      minY: indexData.global_bounds.min_y, 
      maxY: indexData.global_bounds.max_y 
    };
    if (indexData.tiles) {
      validTiles = new Set(indexData.tiles);
    }
  } catch (err) {
    console.error("Failed to fetch index.json, using fallback bounds.", err);
    // Fallback if index.json fails
    rootBounds = { 
      minX: -12.966705322265625, 
      maxX: 27.180025100708008, 
      minY: -18.322017669677734, 
      maxY: 21.98123550415039 
    };
    validTiles.clear(); // Ensure it is empty so TileManager ignores it
  }
  
  const tileManager = new TileManager(TILE_SERVER_URL, rootBounds, validTiles);
  
  uiText.innerHTML = `WebGPU is supported!<br/>Streaming Quadtree Tiles...`;

  const scatterplot = new Scatterplot(rendererWrapper.scene, rendererWrapper);
  
  // Store globally so the buttons can access them
  rendererInstance = rendererWrapper;
  scatterplotInstance = scatterplot;

  const mouse = new THREE.Vector2();
  let lastMouseMoveTime = 0;

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

  const raycaster = new THREE.Raycaster();

  function performCPUPicking(mouseX: number, mouseY: number) {
    const ndcX = (mouseX / window.innerWidth) * 2 - 1;
    const ndcY = -(mouseY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), rendererWrapper.camera);

    const layerSpacing = scatterplot.layerSpacingUniform.value as number;
    const worldUnitsPerPixel = rendererWrapper.worldUnitsPerPixelUniform.value as number;
    
    // 1. Mirror the Shader's Camera Math
    const currentZoom = Math.log2(0.04 / worldUnitsPerPixel);
    const zoomT = Math.max(0, Math.min(1, Math.max(0, currentZoom) / 6.0));
    const targetPixels = 1.2 * (1 - zoomT) + 4.0 * zoomT;
    
    let closestTileKey = "";
    let closestRowIndex = -1;
    let closestTileZ = -1;
    let minDistToCenter = Infinity;
    
    const pt = new THREE.Vector3(); // Pre-allocate to prevent GC memory leaks
    
    // O(1) World-Space Optimization for 2D Mode
    const is2DMode = layerSpacing === 0.0;
    const mouseWorld = new THREE.Vector3();
    const targetZPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
    raycaster.ray.intersectPlane(targetZPlane, mouseWorld);
    
    const worldRadiusBase = (targetPixels / 2.0) * worldUnitsPerPixel;

    for (const t of tileManager.activeTiles) {
      if (!t.geomBuffer) continue;
      
      // QUAD-TREE CULLING: mathematically reject entirely irrelevant tiles!
      // We must expand the bounding box by the maximum visual radius of the points
      // to prevent "Dead Zones" when hovering over the edge of a massive dot!
      const node = tileManager.nodeMap.get(t.key);
      if (node) {
        const maxRadiusWorld = (targetPixels * 10.0 / 2.0) * worldUnitsPerPixel; // 10.0 is safe max instanceSize
        const expandedBox = node.box3.clone().expandByScalar(maxRadiusWorld);
        if (!raycaster.ray.intersectsBox(expandedBox)) {
          continue;
        }
      }
      
      const tileZ = Number(t.key.split('/')[0]);
      const geomArray = new Float32Array(t.geomBuffer);
      const sizeArray = t.sizeBuffer ? new Float32Array(t.sizeBuffer) : null;
      const mesh = scatterplot.tileMeshes.get(t.key);
      if (!mesh) continue;

      for (let i = 0; i < t.numRows; i++) {
        const instanceSize = sizeArray ? sizeArray[i] : 1.0;
        
        if (is2DMode) {
          // ULTRA-FAST WORLD SPACE PICKING FOR 2D
          const px = geomArray[i * 3 + 0];
          const py = geomArray[i * 3 + 1];
          
          const dx = mouseWorld.x - px;
          const dy = mouseWorld.y - py;
          const distSq = dx*dx + dy*dy;
          
          const worldRadius = worldRadiusBase * instanceSize;
          
          if (distSq <= worldRadius * worldRadius) {
            const dist = Math.sqrt(distSq);
            if (dist < minDistToCenter - (worldUnitsPerPixel) || (Math.abs(dist - minDistToCenter) <= (worldUnitsPerPixel) && tileZ > closestTileZ)) {
              closestTileKey = t.key;
              closestRowIndex = i;
              closestTileZ = tileZ;
              minDistToCenter = dist;
            }
          }
        } else {
          // PERSPECTIVE SCREEN-SPACE PICKING FOR 2.5D
          pt.set(
            geomArray[i * 3 + 0],
            geomArray[i * 3 + 1],
            geomArray[i * 3 + 2] * layerSpacing
          );
          
          // Project 3D Coordinates to 2D Screen Pixels
          pt.project(rendererWrapper.camera);
          const screenX = (pt.x + 1) / 2 * window.innerWidth;
          const screenY = -(pt.y - 1) / 2 * window.innerHeight;
          
          const screenRadius = (targetPixels * instanceSize) / 2.0;
          
          const dx = mouseX - screenX;
          const dy = mouseY - screenY;
          const distToCenter = Math.sqrt(dx*dx + dy*dy);
          
          if (distToCenter <= screenRadius) {
            if (distToCenter < minDistToCenter - 1.0 || (Math.abs(distToCenter - minDistToCenter) <= 1.0 && tileZ > closestTileZ)) {
              closestTileKey = t.key;
              closestRowIndex = i;
              closestTileZ = tileZ;
              minDistToCenter = distToCenter;
            }
          }
        }
      }
    }
    
    if (closestTileKey !== "") {
      scatterplot.updateHover(closestTileKey, closestRowIndex, (hoverHtml) => {
        tooltip.style.display = 'block';
        tooltip.style.left = mouseX + 15 + 'px';
        tooltip.style.top = mouseY + 15 + 'px';
        tooltip.style.fontFamily = 'monospace';
        tooltip.innerHTML = hoverHtml;
      });
    } else {
      scatterplot.updateHover("", -1, () => {});
      tooltip.style.display = 'none';
    }
  }

  window.addEventListener('mousemove', (e) => {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
    performCPUPicking(mouse.x, mouse.y);
  });

  rendererWrapper.renderer.setAnimationLoop(() => {
    try {
      // 1. Get frustum
      const frustum = rendererWrapper.getFrustum();
      // 2. Fetch visible tiles (synchronously triggers background fetches)
      const visibleTiles = tileManager.getVisibleTiles(frustum, rendererWrapper.camera.position);
      
      // 3. Update scatterplot geometry
      scatterplot.updateTiles(visibleTiles);
      
      let totalPoints = 0;
      for (const t of visibleTiles) totalPoints += t.numRows;
      uiText.innerHTML = `Streaming Quadtree<br/>Tiles rendered: ${visibleTiles.length}<br/>Points: ${totalPoints}`;

      // 4. Render Main Scene
      rendererWrapper.render();
    } catch (err) {
      console.error("Animation loop crash:", err);
      rendererWrapper.renderer.setAnimationLoop(null); // Stop loop to avoid 3000 errors
    }
  });
}

init().catch(console.error);
