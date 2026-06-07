import * as THREE from 'three';

export interface BoundingBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface TileData {
  key: string;
  geomBuffer: ArrayBuffer | null;
  colorBuffer: ArrayBuffer | null;
  sizeBuffer: ArrayBuffer | null;
  hoverBuffer: ArrayBuffer | null;
  numRows: number;
  semanticReady: boolean;
  needsUpdate: boolean;
}

export class TileNode {
  z: number;
  x: number;
  y: number;
  bounds: BoundingBox;
  box3: THREE.Box3;
  tileData: TileData | null = null;
  fetchStatus: 'idle' | 'loading' | 'done' | 'error' = 'idle';
  lastAccessFrame: number = 0;
  children: TileNode[] | null = null;
  key: string;

  constructor(z: number, x: number, y: number, bounds: BoundingBox) {
    this.z = z;
    this.x = x;
    this.y = y;
    this.key = `${z}/${x}/${y}`;
    this.bounds = bounds;
    this.box3 = new THREE.Box3(
      new THREE.Vector3(bounds.minX, bounds.minY, -1000),
      new THREE.Vector3(bounds.maxX, bounds.maxY, 1000)
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
  private maxConcurrentFetches = 32;

  // LRU Cache tracking
  private currentFrame = 0;
  public maxCacheSize = 1000; // Increased for Additive LOD (needs many tiles simultaneously)
  private validTiles: Set<string>;

  constructor(baseUrl: string, rootBounds: BoundingBox = { minX: 0, minY: 0, maxX: 100, maxY: 100 }, validTiles: Set<string> = new Set()) {
    this.baseUrl = baseUrl;
    this.validTiles = validTiles;
    this.root = new TileNode(0, 0, 0, rootBounds);

    // Initialize Web Worker Pool
    const numWorkers = Math.min(navigator.hardwareConcurrency || 4, 8);
    for (let i = 0; i < numWorkers; i++) {
      const worker = new Worker(new URL('./ArrowWorker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (e) => {
        const { key, stage, error, geomBuffer, numRows, colorBuffer, sizeBuffer, hoverBuffer } = e.data;
        
        if (error) {
          if (error !== '404') console.warn(`Worker error for ${key}:`, error);
          const resolve = this.pendingRequests.get(key);
          if (resolve) resolve(null);
          this.pendingRequests.delete(key);
          return;
        }
        
        if (stage === 'geom') {
          const resolve = this.pendingRequests.get(key);
          if (resolve) {
            resolve({ 
              key, 
              geomBuffer, 
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

  private getTileUrls(z: number, x: number, y: number): { geomUrl: string, semanticUrl: string } {
    return {
      geomUrl: `${this.baseUrl}/${z}/${x}/${y}.geom.arrow`,
      semanticUrl: `${this.baseUrl}/${z}/${x}/${y}.semantic.arrow`
    };
  }

  public async loadTile(node: TileNode): Promise<TileData | null> {
    const key = `${node.z}/${node.x}/${node.y}`;
    if (this.fetchCache.has(key)) {
      return this.fetchCache.get(key)!;
    }

    // Enforce maximum concurrent fetches to prevent network stalls and OOM
    if (this.pendingRequests.size >= this.maxConcurrentFetches) {
      return null;
    }

    const promise = new Promise<TileData | null>((resolve) => {
      this.pendingRequests.set(key, resolve);
      
      // Round-robin dispatch
      const worker = this.workers[this.nextWorkerIndex];
      this.nextWorkerIndex = (this.nextWorkerIndex + 1) % this.workers.length;
      
      const { geomUrl, semanticUrl } = this.getTileUrls(node.z, node.x, node.y);
      worker.postMessage({ geomUrl, semanticUrl, key });
    }).then(data => {
      node.tileData = data;
      node.fetchStatus = data ? 'done' : 'error';
      if (data) {
        console.log(`Loaded tile ${key} with ${data.numRows} rows via Worker.`);
      } else {
        console.log(`Tile ${key} returned 404 (Empty quadrant).`);
      }
      return data;
    });

    this.fetchCache.set(key, promise);
    node.fetchStatus = 'loading';
    return promise;
  }

  // Traverse the quadtree and collect tiles that should be rendered
  // Returns an array of TileData
  public getVisibleTiles(frustum: THREE.Frustum, cameraPos: THREE.Vector3): TileData[] {
    this.currentFrame++;
    if (!this.root) return [];
    
    const visibleTiles: TileData[] = [];
    const queue: TileNode[] = [this.root];

    while (queue.length > 0) {
      const node = queue.shift()!;

      if (!node.intersects(frustum)) {
        continue;
      }

      // If we don't have the table yet, start loading it
      if (!node.tileData && !this.fetchCache.has(`${node.z}/${node.x}/${node.y}`)) {
        console.log(`Starting background load for ${node.z}/${node.x}/${node.y}`);
        this.loadTile(node); 
      }

      // If we have data, we can render this tile's base points
      if (node.tileData) {
        node.lastAccessFrame = this.currentFrame;
        
        let allIntersectingChildrenLoaded = false;
        
        // Distance-based Screen-Space LOD metric
        const center = node.box3.getCenter(new THREE.Vector3());
        const dist = cameraPos.distanceTo(center);
        const nodeSize = node.bounds.maxX - node.bounds.minX;
        
        // Pure Screen-Space Error logic: subdivide if distance is less than 1.5x the tile's physical size
        const shouldSubdivide = dist < nodeSize * 1.5;
        
        if (shouldSubdivide) {
          if (!node.children) {
            this.createChildren(node);
          }
          
          // Only process children that physically exist in the dataset manifest!
          const validChildren = this.validTiles.size > 0 ? node.children!.filter(c => this.validTiles.has(c.key)) : node.children!;
          const intersectingChildren = validChildren.filter(c => c.intersects(frustum));
          
          if (intersectingChildren.length > 0) {
            allIntersectingChildrenLoaded = intersectingChildren.every(c => c.fetchStatus === 'done' || c.fetchStatus === 'error');
            queue.push(...intersectingChildren);
          }
        }
        
        // Additive LOD: Parent points are a unique random sample (skeleton).
        // Children contain the REST of the points. We must render BOTH parent and children!
        visibleTiles.push(node.tileData);
      }
    }

    this.activeTiles = visibleTiles;
    this.evictStaleTiles();
    return visibleTiles;
  }

  private evictStaleTiles() {
    // We count how many nodes actually have tileData
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

    // Sort by oldest access frame first
    loadedNodes.sort((a, b) => a.lastAccessFrame - b.lastAccessFrame);
    
    const excess = loadedCount - this.maxCacheSize;
    let evicted = 0;
    
    for (const node of loadedNodes) {
      if (evicted >= excess) break;
      // Never evict tiles that were accessed THIS frame
      if (node.lastAccessFrame === this.currentFrame) continue;
      
      const key = `${node.z}/${node.x}/${node.y}`;
      this.fetchCache.delete(key);
      node.tileData = null; // Drop reference so garbage collector can clean up
      evicted++;
      console.log(`Evicted tile ${key} from LRU Cache`);
    }
  }

  private createChildren(node: TileNode) {
    const { minX, minY, maxX, maxY } = node.bounds;
    const midX = (minX + maxX) / 2;
    const midY = (minY + maxY) / 2;

    const z = node.z + 1;
    const x = node.x * 2;
    const y = node.y * 2;

    node.children = [
      new TileNode(z, x, y, { minX, minY: midY, maxX: midX, maxY }),             // NW (Top-Left: Y=0 maps to midY->maxY)
      new TileNode(z, x + 1, y, { minX: midX, minY: midY, maxX, maxY }),         // NE (Top-Right: Y=0 maps to midY->maxY)
      new TileNode(z, x, y + 1, { minX, minY, maxX: midX, maxY: midY }),         // SW (Bottom-Left: Y=1 maps to minY->midY)
      new TileNode(z, x + 1, y + 1, { minX: midX, minY, maxX, maxY: midY })      // SE (Bottom-Right: Y=1 maps to minY->midY)
    ];
    
    // Register in nodeMap for semantic updates
    node.children.forEach(c => this.nodeMap.set(`${c.z}/${c.x}/${c.y}`, c));
  }
}
