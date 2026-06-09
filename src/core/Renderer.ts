import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { uniform } from 'three/tsl';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export class Renderer {
  public renderer: WebGPURenderer;
  public scene: THREE.Scene;
  public camera: THREE.OrthographicCamera;
  public controls: OrbitControls;
  public zoomUniform = uniform(1.0);
  public dprUniform = uniform(window.devicePixelRatio);
  public worldUnitsPerPixelUniform = uniform(0.001);
  public zoomTUniform = uniform(0.0);
  public pmremGenerator: THREE.PMREMGenerator | null = null;

  private raycaster = new THREE.Raycaster();
  private mouse = new THREE.Vector2();
  private plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);

  constructor(container: HTMLElement, adapterLimits?: any) {
    const requiredLimits: any = {};
    if (adapterLimits && adapterLimits.maxStorageBufferBindingSize) {
      requiredLimits.maxStorageBufferBindingSize = adapterLimits.maxStorageBufferBindingSize;
      requiredLimits.maxComputeWorkgroupStorageSize = adapterLimits.maxComputeWorkgroupStorageSize;
      requiredLimits.maxStorageBuffersPerShaderStage = adapterLimits.maxStorageBuffersPerShaderStage;
      if (adapterLimits.maxBufferSize) {
          requiredLimits.maxBufferSize = adapterLimits.maxBufferSize;
      }
    }

    this.renderer = new WebGPURenderer({ 
      antialias: true,
      requiredLimits
    });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x111111);

    const aspect = window.innerWidth / window.innerHeight;
    const frustumSize = 4.0; // Show a 4x4 coordinate area on load
    this.camera = new THREE.OrthographicCamera(
      frustumSize * aspect / -2, 
      frustumSize * aspect / 2, 
      frustumSize / 2, 
      frustumSize / -2, 
      0.1, 
      1000
    );
    this.camera.position.set(0.0, 0.0, 5.0); 

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0.0, 0.0, 0);
    this.controls.enableDamping = true;
    
    // 2D MODE DEFAULT
    this.controls.enableRotate = false; 
    // Allow full 360 degree rotation (remove maxPolarAngle restriction)
    this.controls.maxPolarAngle = Math.PI; 
    
    // Disable native zoom so we can implement custom Zoom-to-Mouse
    this.controls.enableZoom = false;
    
    // Reset mouse buttons to standard 2D panning controls
    this.controls.mouseButtons = {
      LEFT: THREE.MOUSE.PAN,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN
    };

    window.addEventListener('resize', this.onWindowResize.bind(this));
    this.renderer.domElement.addEventListener('wheel', this.onWheel.bind(this), { passive: false });
  }

  private onWheel(event: WheelEvent) {
    event.preventDefault(); // Prevent page scroll
    
    const zoomFactor = event.deltaY > 0 ? 1.1 : 0.9;
    
    // Prevent zooming too close where WebGPU Float32 precision breaks
    if (zoomFactor < 1.0 && this.camera.zoom > 1000000.0) return;
    
    // Find world point before zoom
    this.mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
    this.mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
    this.raycaster.setFromCamera(this.mouse, this.camera);
    
    const intersectionBefore = new THREE.Vector3();
    if (this.raycaster.ray.intersectPlane(this.plane, intersectionBefore)) {
      
      // Apply zoom
      this.camera.zoom /= zoomFactor;
      this.camera.updateProjectionMatrix();
      
      // Find world point after zoom
      this.raycaster.setFromCamera(this.mouse, this.camera);
      const intersectionAfter = new THREE.Vector3();
      if (this.raycaster.ray.intersectPlane(this.plane, intersectionAfter)) {
         // Shift camera to align points
         const delta = intersectionBefore.sub(intersectionAfter);
         this.camera.position.add(delta);
         this.controls.target.add(delta);
         this.camera.updateMatrixWorld();
      }
    }
  }

  public set2DMode(is2D: boolean) {
    const currentDist = this.camera.position.distanceTo(this.controls.target);
    if (is2D) {
      this.controls.enableRotate = false;
      this.controls.mouseButtons.LEFT = THREE.MOUSE.PAN;
      // Snap to perfect top-down view
      this.camera.position.set(this.controls.target.x, this.controls.target.y, currentDist);
    } else {
      this.controls.enableRotate = true;
      this.controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
      // Tilt back to 45 degree angle
      const yOffset = currentDist * Math.sin(Math.PI / 4);
      const zOffset = currentDist * Math.cos(Math.PI / 4);
      this.camera.position.set(this.controls.target.x, this.controls.target.y - yOffset, zOffset);
    }
    this.controls.update();
  }

  private onWindowResize() {
    const aspect = window.innerWidth / window.innerHeight;
    const frustumSize = 4.0;
    this.camera.left = -frustumSize * aspect / 2;
    this.camera.right = frustumSize * aspect / 2;
    this.camera.top = frustumSize / 2;
    this.camera.bottom = -frustumSize / 2;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  public getFrustum(): THREE.Frustum {
    const frustum = new THREE.Frustum();
    const projScreenMatrix = new THREE.Matrix4();
    this.camera.updateMatrixWorld();
    projScreenMatrix.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projScreenMatrix);
    return frustum;
  }

  public render() {
    this.controls.update();
    
    // Update uniforms for TSL using Orthographic focal plane math
    const visibleHeight = (this.camera.top - this.camera.bottom) / this.camera.zoom;
    
    this.worldUnitsPerPixelUniform.value = visibleHeight / window.innerHeight;
    
    this.zoomUniform.value = this.camera.zoom; 
    this.dprUniform.value = window.devicePixelRatio;

    const currentZoom = Math.log2(Math.max(1.0, this.camera.zoom));
    this.zoomTUniform.value = Math.max(0.0, Math.min(1.0, currentZoom / 6.0));
    
    this.renderer.render(this.scene, this.camera);
  }

  public async init() {
    await this.renderer.init();
  }
}
