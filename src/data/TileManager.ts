import * as THREE from 'three';

export interface BoundingBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface TileData {
  key: string;
  numRows: number;
  bounds: BoundingBox;
  xBuffer?: ArrayBuffer;
  yBuffer?: ArrayBuffer;
  ixBuffer?: ArrayBuffer;
  colorBuffer?: ArrayBuffer;
  sizeBuffer?: ArrayBuffer;
  hoverBuffer?: ArrayBuffer;
  semanticReady: boolean;
  needsUpdate: boolean;
  minIx?: number;
  maxIx?: number;
}

export class TileNode {
  z: number; // depth
  x: number;
  y: number;
  bounds: BoundingBox;
  box3: THREE.Box3;
  tileData: TileData | null = null;
  fetchStatus: 'idle' | 'loading' | 'done' | 'error' | 'unloaded' = 'idle';
  fetchErrorReason?: string;
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
  public lruCache: Map<string, TileNode> = new Map(); // O(1) LRU Cache
  private workers: Worker[] = [];
  private tileToWorker: Map<string, Worker> = new Map();
  private nextWorkerIndex = 0;

  private currentFrame = 0;
  public maxCacheSize = 800; // Match GPU capacity to prevent cache thrashing
  public onTileUnloaded?: (tileId: string) => void;
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
        const { key, stage, error, geomBuffer, xBuffer, yBuffer, ixBuffer, numRows, colorBuffer, sizeBuffer, hoverBuffer, minIx, maxIx } = e.data;
        if (error) {
          if (error !== 'AbortError') console.warn(`Worker error for ${key}:`, error);
          
          const node = this.nodeMap.get(key);
          if (node) {
              node.fetchStatus = 'error';
              node.fetchErrorReason = error;
          }
          
          const resolve = this.pendingRequests.get(key);
          if (resolve) resolve(null);
          this.pendingRequests.delete(key);
          this.tileToWorker.delete(key);
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
              needsUpdate: false,
              minIx,
              maxIx
            });
            this.pendingRequests.delete(key);
            this.tileToWorker.delete(key); // Cleanup
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
      
      this.tileToWorker.set(key, worker);
      
      const tileUrl = this.getTileUrl(node.z, node.x, node.y);
      worker.postMessage({ tileUrl, key });
    }).then(data => {
      if (data) {
        data.bounds = node.bounds;
      }
      node.tileData = data;
      node.fetchStatus = 'done'; // Even if null (empty), it's done fetching
      if (data) {
        this.lruCache.delete(key);
        this.lruCache.set(key, node); // Add to LRU cache on load
        console.log(`Loaded tile ${key} with ${data.numRows} rows.`);
      }
      return data;
    });

    this.fetchCache.set(key, promise);
    node.fetchStatus = 'loading';
    return promise;
  }

  private calculateSSE(node: TileNode, camera: THREE.OrthographicCamera): number {
    const visibleHeight = (camera.top - camera.bottom) / camera.zoom;
    const nodeSize = node.bounds.maxX - node.bounds.minX;
    
    // The error is the size of the node in screen pixels
    return (nodeSize / visibleHeight) * window.innerHeight;
  }

  // Traverse the quadtree and collect tiles that should be rendered
  // Returns an array of TileData
  public getVisibleTiles(frustum: THREE.Frustum, camera: THREE.OrthographicCamera, currentMaxIx: number): TileData[] {
    this.currentFrame++;
    
    if (!this.root) return [];
    
    const visibleTiles: TileData[] = [];
    const desiredTiles: TileNode[] = [];
    
    // Traversal queue
    let currentQueue: TileNode[] = [this.root];
    this.root.error = this.calculateSSE(this.root, camera);
    
    // Traverse using Two-Queue method
    while (currentQueue.length > 0) {
      const cx = camera.position.x;
      const cy = camera.position.y;
      
      const nextQueue: TileNode[] = [];
      
      for (const node of currentQueue) {
        const inFrustum = node.intersects(frustum);
        
        // Phase 3 Fix: If a node is completely out of the padded frustum, drop it entirely!
        if (!inFrustum && node.z !== 0) {
            continue;
        }
        
        // --- ZERO-COST CPU CULLING ---
        if (node.tileData && node.tileData.minIx !== undefined && node.tileData.minIx > currentMaxIx) {
            continue; 
        }
        
        desiredTiles.push(node);

        // Additive LOD: If we reached this node, we want to render it (if loaded)
        if (node.tileData) {
          node.lastAccessFrame = this.currentFrame;
          visibleTiles.push(node.tileData);
          
          // Update LRU Cache
          this.lruCache.delete(node.key);
          this.lruCache.set(node.key, node);
        }

        // Dynamic threshold based on cache pressure
        // If we are getting close to maxCacheSize, we relax the threshold (increase it) to stop subdividing
        const cachePressure = desiredTiles.length / this.maxCacheSize;
        const dynamicMultiplier = 1.0 + Math.max(0, cachePressure - 0.5) * 4.0; // If >50% full, increase threshold up to 3x
        
        const baseThreshold = inFrustum ? 128 : 256;
        let subdivideThreshold = baseThreshold * dynamicMultiplier;
        
        // Hysteresis: Check if it was already subdivided recently by seeing if children have fetchStatus 'done'
        const hasLoadedChildren = node.children && node.children.some(c => c.fetchStatus === 'done');
        if (hasLoadedChildren) {
            subdivideThreshold *= 0.8; // 20% easier to KEEP subdivided
        } else {
            subdivideThreshold *= 1.2; // 20% harder to INITIALLY subdivide
        }

        let shouldSubdivide = node.error > subdivideThreshold && node.z < 16;
        
        if (shouldSubdivide && node.fetchStatus === 'done' && node.tileData) {
          if (!node.children) {
            this.createChildren(node);
          }
          
          let validChildren = node.children!;
          if (node.validChildrenKeys) {
              validChildren = node.children!.filter(c => node.validChildrenKeys!.has(c.key));
          } else if (this.validTiles.size > 0) {
              validChildren = node.children!.filter(c => this.validTiles.has(c.key));
          }
          
          for (const c of validChildren) {
            c.error = this.calculateSSE(c, camera);
            nextQueue.push(c);
          }
        }
      }
      
      // --- BFS COMPLETE-LEVEL HARDCAP ---
      // We must only cull AT THE END of a Z-level to prevent sharp tiling artifacts!
      // If we have rendered enough tiles to saturate the GPU (~50), we completely stop
      // traversing into deeper Z-levels. By stopping at a level boundary, density remains uniform.
      if (visibleTiles.length >= 50) {
          break;
      }
      
      // Sort nextLevelQueue ONCE per depth level
      nextQueue.sort((a, b) => {
        const errorDiff = b.error - a.error;
        if (Math.abs(errorDiff) > 50.0) return errorDiff;
        
        const getDist = (node: TileNode) => {
            const centerX = (node.bounds.minX + node.bounds.maxX) / 2;
            const centerY = (node.bounds.minY + node.bounds.maxY) / 2;
            return Math.hypot(centerX - cx, centerY - cy);
        };
        return getDist(a) - getDist(b);
      });
      
      currentQueue = nextQueue;
    }

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

    // Aggressive Network Cleanup: Abort loading tiles that fell out of the desired frustum
    const desiredKeys = new Set(desiredTiles.map(n => n.key));
    
    for (const [key, promise] of this.fetchCache.entries()) {
      const node = this.nodeMap.get(key);
      if (node && node.fetchStatus === 'loading' && !desiredKeys.has(key)) {
        // Tile is loading but no longer in the expanded frustum! Abort it!
        const worker = this.tileToWorker.get(key);
        if (worker) {
            worker.postMessage({ action: 'abort', key });
            this.tileToWorker.delete(key);
        }
        
        // Resolve the promise to prevent memory leaks in the main thread
        const resolve = this.pendingRequests.get(key);
        if (resolve) resolve(null);
        this.pendingRequests.delete(key);
        
        this.fetchCache.delete(key);
            node.fetchStatus = 'idle';
        console.log(`Aborted stale fetch for ${key}`);
      }
    }

    // Throttle new fetches to avoid network saturation (Browser max is usually 6 per domain)
    // We limit total concurrent fetches across all workers to 6.
    const MAX_CONCURRENT_FETCHES = 6;
    
    for (const node of desiredTiles) {
      if (this.pendingRequests.size >= MAX_CONCURRENT_FETCHES) {
          break; // Stop issuing new fetches until some finish!
      }
      
      // If it previously failed due to a network timeout, we CAN retry it, 
      // but only if it's currently highly desired (in frustum).
      // We NEVER retry 404s, because those files mathematically do not exist.
      if (node.fetchStatus === 'error' && node.fetchErrorReason !== '404') {
          node.fetchStatus = 'idle';
          this.fetchCache.delete(node.key);
      }
      
      if (!node.tileData && !this.fetchCache.has(node.key)) {
        this.loadTile(node);
      }
    } 

    this.activeTiles = visibleTiles;
    this.evictStaleTiles();
    return visibleTiles;
  }

  private evictStaleTiles() {
    // Phase 2: O(1) LRU Cache Eviction!
    if (this.lruCache.size <= this.maxCacheSize) return;

    const excess = this.lruCache.size - this.maxCacheSize;
    let evicted = 0;
    
    for (const [key, node] of this.lruCache.entries()) {
      if (evicted >= excess) break;
      // Never evict tiles that were accessed THIS frame (Ancestry Protection)
      if (node.lastAccessFrame === this.currentFrame) continue;
      // Never evict shallow background layers
      if (node.z < 2) continue;
      
      // If a node was marked as a 404 error, we don't need to evict its data (it has none),
      if (node.fetchStatus === 'error') continue;

      this.fetchCache.delete(node.key);
      node.tileData = null; // Drop reference so garbage collector can clean up
      node.fetchStatus = 'idle'; // Reset status so it can be fetched again
      
      if (this.onTileUnloaded) {
          this.onTileUnloaded(node.key);
      }
      
      this.lruCache.delete(key);
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

    // quadfeather uses standard spatial indexing where y=0 maps to the first half of the domain [minY, midY].
    // Since WebGL Y goes up, [minY, midY] is the Bottom Half.
    node.children = [
      new TileNode(z, x, y, { minX, minY, maxX: midX, maxY: midY }),                 // Bottom-Left (Even Y)
      new TileNode(z, x + 1, y, { minX: midX, minY, maxX, maxY: midY }),             // Bottom-Right (Even Y)
      new TileNode(z, x, y + 1, { minX, minY: midY, maxX: midX, maxY }),             // Top-Left (Odd Y)
      new TileNode(z, x + 1, y + 1, { minX: midX, minY: midY, maxX, maxY })          // Top-Right (Odd Y)
    ];
    
    // Register in nodeMap for semantic updates
    node.children.forEach(c => this.nodeMap.set(c.key, c));
  }
}

