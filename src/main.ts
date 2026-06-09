import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { 
  attribute, float, positionLocal, vec3, vec4, vec2, uv, distance, smoothstep,
  fwidth, hash, instanceIndex, Discard, max, min, userData, uint, mix,
  log2, clamp, pow, uniformArray, uniform, select, length, floor, varying
} from 'three/tsl';
import { Renderer } from './core/Renderer';
import { TileManager, BoundingBox, TileData } from './data/TileManager';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import Stats from 'three/examples/jsm/libs/stats.module.js';
const TILE_SERVER_URL = 'https://files.benschmidt.org/tiles/gaia';

// --- Shader-Side Color Palettes ---
export const warmPaletteColors = ['#ffeda0', '#feb24c', '#f03b20', '#bcbddc', '#756bb1'];
export const coolPaletteColors = ['#f1eef6', '#bdc9e1', '#74a9cf', '#2b8cbe', '#045a8d'];

export let isWarmPalette = true;

// Create a dedicated array of THREE.Color objects for the uniform
export const activePalette = warmPaletteColors.map(c => new THREE.Color(c));

// We define the uniform array node so TSL can mathematically index into it
export const paletteUniform = uniformArray(activePalette);

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

import { Scatterplot } from './Scatterplot';
import { Renderer } from './core/Renderer';

let is2DMode = true; // 2D by default
let rendererInstance: Renderer | null = null;
let scatterplotInstance: Scatterplot | null = null;

(window as any).swapMode = () => {
  is2DMode = !is2DMode;
  if (scatterplotInstance) {
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



async function init() {
  const container = document.getElementById('app')!;
  const uiText = document.querySelector('#ui p')!;

  if (!navigator.gpu) {
    uiText.textContent = 'WebGPU is not supported by your browser.';
    return;
  }
  const adapter = await navigator.gpu.requestAdapter();
  const limits = adapter ? adapter.limits : undefined;
  const rendererWrapper = new Renderer(container, limits);
  await rendererWrapper.init();

  const stats = new Stats();
  stats.showPanel(0); // 0: fps, 1: ms, 2: mb, 3+: custom
  // Position it in the top right so it doesn't overlap the UI
  stats.dom.style.position = 'absolute';
  stats.dom.style.top = '0px';
  stats.dom.style.right = '0px';
  stats.dom.style.left = 'auto'; // override default left
  document.body.appendChild(stats.dom);

  const rootBounds = { minX: -2.0, maxX: 2.0, minY: -2.0, maxY: 2.0 };
  const validTiles = new Set<string>();
  
  const tileManager = new TileManager(TILE_SERVER_URL, rootBounds, validTiles);
  (window as any).tileManagerInstance = tileManager;
  
  uiText.innerHTML = `WebGPU is supported!<br/>Streaming Quadtree Tiles...`;

  const scatterplot = new Scatterplot(rendererWrapper.scene, rendererWrapper, rootBounds);
  
  rendererInstance = rendererWrapper;
  scatterplotInstance = scatterplot;

  const mouse = new THREE.Vector2();

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

  async function performGPUPicking(mouseX: number, mouseY: number) {
    if (!scatterplot.pickingRenderTarget.texture) return;
    
    // 1. Position the 1x1 picking camera perfectly under the mouse cursor
    const pickingCamera = rendererWrapper.camera.clone() as THREE.OrthographicCamera;
    pickingCamera.setViewOffset(
        window.innerWidth, window.innerHeight,
        mouseX, mouseY,
        1, 1
    );

    // 2. Hide hoverMesh during picking
    scatterplot.hoverMesh.visible = false;

    // 3. Override per-mesh picking materials
    const originalMaterials = new Map<THREE.Mesh, THREE.Material>();
    rendererWrapper.scene.traverse((child) => {
        if (child instanceof THREE.Mesh && child.userData.pickingMaterial) {
            originalMaterials.set(child, child.material);
            child.material = child.userData.pickingMaterial;
        }
    });

    // 4. Render directly to the 1x1 Render Target
    rendererWrapper.renderer.setRenderTarget(scatterplot.pickingRenderTarget);
    await rendererWrapper.renderer.renderAsync(rendererWrapper.scene, pickingCamera);

    // 5. Restore scene state
    rendererWrapper.renderer.setRenderTarget(null);
    for (const [mesh, origMat] of originalMaterials.entries()) {
        mesh.material = origMat;
    }

    // 6. Read back the exact 4 bytes asynchronously!
    const buffer = await rendererWrapper.renderer.readRenderTargetPixelsAsync(
        scatterplot.pickingRenderTarget, 
        0, 0, 1, 1
    );

    if (!buffer) return;

    // Decode: RGBA -> globalId
    // Background pixels have Alpha=0. Valid picked IDs have Alpha >= 1 due to our 0x01000000 offset.
    if (buffer[3] === 0) {
        scatterplot.updateHover(-1, () => {});
        tooltip.style.display = 'none';
        return;
    }

    const decodedId = buffer[0] | (buffer[1] << 8) | (buffer[2] << 16) | (buffer[3] << 24);
    const globalId = decodedId - 0x01000000;

    scatterplot.updateHover(globalId, (hoverHtml) => {
        tooltip.style.display = 'block';
        tooltip.style.left = mouseX + 15 + 'px';
        tooltip.style.top = mouseY + 15 + 'px';
        tooltip.style.fontFamily = 'monospace';
        tooltip.innerHTML = hoverHtml;
    });
  }

  let isPickingScheduled = false;
  window.addEventListener('mousemove', (e) => {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
    if (!isPickingScheduled) {
      isPickingScheduled = true;
      performGPUPicking(mouse.x, mouse.y).then(() => {
          isPickingScheduled = false;
      }).catch(err => {
          console.error("Picking error", err);
          isPickingScheduled = false;
      });
    }
  });

  // Connect TileManager's Cache Eviction to Scatterplot's GPU slots
  tileManager.onTileUnloaded = (tileId: string) => {
      scatterplot.unloadTile(tileId);
  };

  rendererWrapper.renderer.setAnimationLoop(() => {
    try {
      // 1. Get frustum
      const frustum = rendererWrapper.getFrustum();
      // 2. Fetch visible tiles (synchronously triggers background fetches)
      const visibleTiles = tileManager.getVisibleTiles(frustum, rendererWrapper.camera);
      
      // 3. Update scatterplot geometry and compute nodes
      scatterplot.updateTiles(visibleTiles);
      
      let totalPoints = 0;
      for (const t of visibleTiles) totalPoints += t.numRows;
      uiText.innerHTML = `Streaming Quadtree<br/>Tiles rendered: ${visibleTiles.length}<br/>Points: ${totalPoints}`;

      // 4. Dispatch Compute Shaders (Removed)
      scatterplot.updateCamera(rendererWrapper.camera);

      // 5. Render Main Scene
      rendererWrapper.render();
      stats.update();
    } catch (err) {
      console.error("Animation loop crash:", err);
      rendererWrapper.renderer.setAnimationLoop(null); // Stop loop to avoid 3000 errors
    }
  });
}

init().catch(console.error);
