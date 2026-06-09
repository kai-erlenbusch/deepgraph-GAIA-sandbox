import * as THREE from 'three';

export interface BoundingBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface TileData {
  key: string;
  xBuffer: ArrayBuffer | null;
  yBuffer: ArrayBuffer | null;
  ixBuffer: ArrayBuffer | null;
  colorBuffer: ArrayBuffer | null;
  sizeBuffer: ArrayBuffer | null;
  hoverBuffer: ArrayBuffer | null;
  numRows: number;
  semanticReady: boolean;
  needsUpdate: boolean;
  bounds?: BoundingBox;
}

export class TileNode {
  z: number; // depth
  x: number;
  y: number;
  bounds: BoundingBox;
  box3: THREE.Box3;
  tileData: TileData | null = null;
  fetchStatus: 'idle' | 'loading' | 'done' | 'error' = 'idle';
  lastAccessFrame: number = 0;
  children: TileNode[] | null = null;
  key: string;
  validChildrenKeys: Set<string> | null = null;
  
  // SSE Tracking
  error: number = 0;

  constructor(z: number, x: number, y: number, bounds: BoundingBox) {
    this.z = z;
    this.x = x;
    this.y = y;
    this.key = `${z}/${x}/${y}`;
    this.bounds = bounds;
    
    // Expanded bounds slightly so we intersect frustum even when just outside (Hysteresis padding)
    const padX = (bounds.maxX - bounds.minX) * 0.1; 
    const padY = (bounds.maxY - bounds.minY) * 0.1;
    this.box3 = new THREE.Box3(
      new THREE.Vector3(bounds.minX - padX, bounds.minY - padY, -0.1),
      new THREE.Vector3(bounds.maxX + padX, bounds.maxY + padY, 0.1)
    );
  }

  // Check if this tile intersects with the camera viewport
  intersects(frustum: THREE.Frustum): boolean {
    return frustum.intersectsBox(this.box3);
  }
}

export class TileManager {
  private baseUrl: string;
  public root: TileNode | null = null;
  public activeTiles: TileData[] = [];
  
  // Track fetching to avoid duplicate requests
  private fetchCache: Map<string, Promise<TileData | null>> = new Map();
  private pendingRequests: Map<string, (data: TileData | null) => void> = new Map();
  public nodeMap: Map<string, TileNode> = new Map();
  private workers: Worker[] = [];
  private nextWorkerIndex = 0;

  private currentFrame = 0;
  public maxCacheSize = 800; // Match GPU capacity to prevent cache thrashing
  private validTiles: Set<string>;
  private cacheBuster: number = Date.now();

  constructor(baseUrl: string, rootBounds: BoundingBox = { minX: 0, minY: 0, maxX: 100, maxY: 100 }, validTiles: Set<string> = new Set()) {
    this.baseUrl = baseUrl;
    this.validTiles = validTiles;
    this.root = new TileNode(0, 0, 0, rootBounds);
    this.nodeMap.set('0/0/0', this.root); // Ensure root is in nodeMap so metadata injection works

    // Initialize Web Worker Pool
    const numWorkers = Math.min(navigator.hardwareConcurrency || 4, 8);
    for (let i = 0; i < numWorkers; i++) {
      const worker = new Worker(new URL('./ArrowWorker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (e) => {
        const { key, stage, error, geomBuffer, xBuffer, yBuffer, ixBuffer, numRows, colorBuffer, sizeBuffer, hoverBuffer } = e.data;
        
        if (error) {
          if (error !== '404') console.warn(`Worker error for ${key}:`, error);
          const resolve = this.pendingRequests.get(key);
          if (resolve) resolve(null);
          this.pendingRequests.delete(key);
          return;
        }
        
        if (stage === 'geom') {
          const node = this.nodeMap.get(key);
          if (node) {
              if (e.data.childrenKeys) {
                  node.validChildrenKeys = new Set(e.data.childrenKeys);
              }
              if (e.data.extent && node.z === 0) {
                  const { x, y } = e.data.extent;
                  const padX = (x[1] - x[0]) * 0.1;
                  const padY = (y[1] - y[0]) * 0.1;
                  node.bounds = { minX: x[0], maxX: x[1], minY: y[0], maxY: y[1] };
                  node.box3.set(
                      new THREE.Vector3(x[0] - padX, y[0] - padY, -0.1),
                      new THREE.Vector3(x[1] + padX, y[1] + padY, 0.1)
                  );
                  console.log("Dynamically updated root bounds from 0/0/0.feather metadata:", node.bounds);
                  
                  // CRITICAL FIX: The Quadtree might have already generated Z=1 children using the initial 
                  // dummy bounds [-2, 2] before the network fetch completed.
                  // We must destroy them so they regenerate mathematically correct physical bounds.
                  if (node.children) {
                      for (const child of node.children) {
                          this.nodeMap.delete(child.key);
                      }
                      node.children = undefined;
                  }
              }
          }
          const resolve = this.pendingRequests.get(key);
          if (resolve) {
            resolve({ 
              key, 
              xBuffer,
              yBuffer,
              ixBuffer,
              colorBuffer: null, 
              sizeBuffer: null, 
              hoverBuffer: null, 
              numRows, 
              semanticReady: false,
              needsUpdate: false 
            });
            this.pendingRequests.delete(key);
          }
        } else if (stage === 'semantic') {
          const node = this.nodeMap.get(key);
          if (node && node.tileData) {
            node.tileData.colorBuffer = colorBuffer;
            node.tileData.sizeBuffer = sizeBuffer;
            node.tileData.hoverBuffer = hoverBuffer;
            node.tileData.semanticReady = true;
            node.tileData.needsUpdate = true; // Signal main thread to update GPU buffer
          }
        }
      };
      this.workers.push(worker);
    }
  }

  public async init() {
    await this.loadTile(this.root!);
  }

  private getTileUrl(z: number, x: number, y: number): string {
    const key = `${z}/${x}/${y}`;
    return `${this.baseUrl}/${key}.feather`;
  }

  public async loadTile(node: TileNode): Promise<TileData | null> {
    const key = `${node.z}/${node.x}/${node.y}`;
    if (this.fetchCache.has(key)) {
      return this.fetchCache.get(key)!;
    }

    const promise = new Promise<TileData | null>((resolve) => {
      this.pendingRequests.set(key, resolve);
      
      // Round-robin dispatch
      const worker = this.workers[this.nextWorkerIndex];
      this.nextWorkerIndex = (this.nextWorkerIndex + 1) % this.workers.length;
      const tileUrl = this.getTileUrl(node.z, node.x, node.y);
      worker.postMessage({ tileUrl, key });
    }).then(data => {
      if (data) {
        data.bounds = node.bounds;
      }
      node.tileData = data;
      node.fetchStatus = 'done'; // Even if null (empty), it's done fetching
      if (data) {
        console.log(`Loaded tile ${key} with ${data.numRows} rows.`);
      }
      return data;
    });

    this.fetchCache.set(key, promise);
    node.fetchStatus = 'loading';
    return promise;
  }

  // Calculate mathematically correct Screen-Space Error based on the orthographic camera's zoom
  private calculateSSE(node: TileNode, camera: THREE.OrthographicCamera): number {
    const visibleHeight = (camera.top - camera.bottom) / camera.zoom;
    const nodeSize = node.bounds.maxX - node.bounds.minX;
    
    // The error is the size of the node in screen pixels
    return (nodeSize / visibleHeight) * window.innerHeight;
  }

  // Traverse the quadtree and collect tiles that should be rendered
  // Returns an array of TileData
  public getVisibleTiles(frustum: THREE.Frustum, camera: THREE.OrthographicCamera): TileData[] {
    this.currentFrame++;
    
    if (!this.root) return [];
    
    const visibleTiles: TileData[] = [];
    const desiredTiles: TileNode[] = [];
    
    // Traversal queue
    const queue: TileNode[] = [this.root];
    this.root.error = this.calculateSSE(this.root, camera);
    
    let totalPointsRendered = 0;

    // Traverse to determine required Level of Detail based on SSE
    while (queue.length > 0) {
      // Sort queue to ensure we process the most important tiles first
      const cx = camera.position.x;
      const cy = camera.position.y;
      
      queue.sort((a, b) => {
        // Primary Sort: node.error (guarantees lower Z levels are processed first)
        const errorDiff = b.error - a.error;
        if (Math.abs(errorDiff) > 1.0) {
            return errorDiff;
        }
        
        // Tie-Breaker: Foveated distance (tiles closer to screen center get processed first)
        const getDist = (node: TileNode) => {
            const centerX = (node.bounds.minX + node.bounds.maxX) / 2;
            const centerY = (node.bounds.minY + node.bounds.maxY) / 2;
            return Math.hypot(centerX - cx, centerY - cy);
        };
        return getDist(a) - getDist(b); // smaller distance = closer = process first
      });

      const node = queue.shift()!;
      
      const inFrustum = node.intersects(frustum);
      
      desiredTiles.push(node);

      // Additive LOD: If we reached this node, we want to render it (if loaded)
      if (node.tileData) {
        node.lastAccessFrame = this.currentFrame;
        // Only actually render it if it intersects the strict frustum
        if (inFrustum) {
          visibleTiles.push(node.tileData);
          totalPointsRendered += node.tileData.numRows;
        }
      }

      // Frustum LOD Hysteresis
      // We lower the threshold to 128 pixels to aggressively load deeper detail
      const subdivideThreshold = inFrustum ? 128 : 256;
      let shouldSubdivide = node.error > subdivideThreshold && node.z < 16;
      
      // THE FIX: Override subdivision if we are over budget!
      if (totalPointsRendered >= 5000000) { 
          shouldSubdivide = false; 
      }
      
      // In Additive LOD, we MUST traverse to children if they exist in cache, 
      // otherwise they get erroneously removed from the GPU!
      let traverseToChildren = shouldSubdivide;
      if (!traverseToChildren && node.children) {
          traverseToChildren = node.children.some(c => c.tileData !== null || c.fetchStatus === 'loading');
      }
      
      if (traverseToChildren && node.fetchStatus === 'done' && node.tileData) {
        if (!node.children) {
          this.createChildren(node);
        }
        
        let validChildren = node.children!;
        if (node.validChildrenKeys) {
            validChildren = node.children!.filter(c => node.validChildrenKeys!.has(c.key));
        } else if (this.validTiles.size > 0) {
            validChildren = node.children!.filter(c => this.validTiles.has(c.key));
        }
        
        // We evaluate all children, but they will be tested against the frustum in their own queue pop
        for (const c of validChildren) {
          c.error = this.calculateSSE(c, camera);
          queue.push(c);
        }
      }
    }

    // We no longer need to sort desiredTiles here because the traversal queue 
    // naturally added them in priority order, so desiredTiles is already somewhat 
    // prioritized. But we can keep the fetches focused on the front of desiredTiles.
    
    // Sort desiredTiles to ensure fetching prioritizes the best tiles
    const cx = camera.position.x;
    const cy = camera.position.y;
    const visibleHeight = (camera.top - camera.bottom) / camera.zoom;
    
    const getEffectivePriority = (node: TileNode) => {
        const centerX = (node.bounds.minX + node.bounds.maxX) / 2;
        const centerY = (node.bounds.minY + node.bounds.maxY) / 2;
        const dist = Math.hypot(centerX - cx, centerY - cy);
        const normalizedDist = dist / visibleHeight;
        return node.error / (1.0 + normalizedDist * 4.0);
    };
    
    desiredTiles.sort((a, b) => {
      return getEffectivePriority(b) - getEffectivePriority(a);
    });

    const MAX_NEW_FETCHES_PER_FRAME = 20;
    let newFetchesThisFrame = 0;

    // Issue fetches based on Priority Queue
    for (const node of desiredTiles) {
      if (newFetchesThisFrame >= MAX_NEW_FETCHES_PER_FRAME) break;

      if (!node.tileData && !this.fetchCache.has(node.key)) {
        this.loadTile(node);
        newFetchesThisFrame++;
      }
    }

    this.activeTiles = visibleTiles;
    this.evictStaleTiles();
    return visibleTiles;
  }

  private evictStaleTiles() {
    let loadedCount = 0;
    const loadedNodes: TileNode[] = [];
    
    const traverse = (n: TileNode) => {
      if (n.tileData) {
        loadedCount++;
        loadedNodes.push(n);
      }
      if (n.children) n.children.forEach(traverse);
    };
    
    if (this.root) traverse(this.root);

    if (loadedCount <= this.maxCacheSize) return;

    // To prevent visual holes, evict deepest tiles first (Z descending), then by LRU
    loadedNodes.sort((a, b) => {
      if (a.z !== b.z) {
        return b.z - a.z; // Evict deeper tiles first
      }
      return a.lastAccessFrame - b.lastAccessFrame; // Evict oldest accessed first
    });
    
    const excess = loadedCount - this.maxCacheSize;
    let evicted = 0;
    
    for (const node of loadedNodes) {
      if (evicted >= excess) break;
      // Never evict tiles that were accessed THIS frame (Ancestry Protection)
      if (node.lastAccessFrame === this.currentFrame) continue;
      // Never evict shallow background layers
      if (node.z < 2) continue;
      
      this.fetchCache.delete(node.key);
      node.tileData = null; // Drop reference so garbage collector can clean up
      node.fetchStatus = 'idle'; // Reset status so it can be fetched again
      evicted++;
      console.log(`Evicted tile ${node.key} (Z=${node.z}) from Cache`);
    }
  }

  private createChildren(node: TileNode) {
    const { minX, minY, maxX, maxY } = node.bounds;
    const midX = (minX + maxX) / 2;
    const midY = (minY + maxY) / 2;

    const z = node.z + 1;
    const x = node.x * 2;
    const y = node.y * 2;

    // In this specific GAIA Deepscatter dataset:
    // Standard web-mapping (Slippy Map) defines Y=0 at the Top.
    node.children = [
      new TileNode(z, x, y + 1, { minX, minY, maxX: midX, maxY: midY }),             // SW (Bottom-Left)
      new TileNode(z, x + 1, y + 1, { minX: midX, minY, maxX, maxY: midY }),         // SE (Bottom-Right)
      new TileNode(z, x, y, { minX, minY: midY, maxX: midX, maxY }),                 // NW (Top-Left)
      new TileNode(z, x + 1, y, { minX: midX, minY: midY, maxX, maxY })              // NE (Top-Right)
    ];
    
    // Register in nodeMap for semantic updates
    node.children.forEach(c => this.nodeMap.set(c.key, c));
  }
}

