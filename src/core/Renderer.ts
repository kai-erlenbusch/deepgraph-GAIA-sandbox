import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { uniform } from 'three/tsl';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export class Renderer {
  public renderer: WebGPURenderer;
  public scene: THREE.Scene;
  public camera: THREE.PerspectiveCamera;
  public controls: OrbitControls;
  public zoomUniform = uniform(1.0);
  public dprUniform = uniform(window.devicePixelRatio);
  public worldUnitsPerPixelUniform = uniform(40 / window.innerHeight);

  constructor(container: HTMLElement) {
    this.renderer = new WebGPURenderer({ antialias: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x111111);

    // Standard 45-degree field of view
    this.camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 5000);
    // Position the camera further back on the Z axis to account for perspective
    this.camera.position.set(7.1, -20.0, 50.0); 

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(7.1, 1.8, 0);
    this.controls.enableDamping = true;
    
    // ENABLE 3D ROTATION
    this.controls.enableRotate = true; 
    // Prevent the camera from going "underground" below the Z=0 plane
    this.controls.maxPolarAngle = Math.PI / 2.1; 
    
    // Reset mouse buttons to standard 3D orbit controls
    this.controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN
    };

    window.addEventListener('resize', this.onWindowResize.bind(this));
  }

  private onWindowResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  public getViewportBounds() {
    // Calculate the physical size of the focal plane in World Units
    const dist = this.camera.position.distanceTo(this.controls.target);
    const fovRad = THREE.MathUtils.degToRad(this.camera.fov);
    const visibleHeight = 2 * Math.tan(fovRad / 2) * dist;
    const visibleWidth = visibleHeight * this.camera.aspect;
    
    // When the camera tilts, a pure top-down box isn't enough. 
    // We multiply the bounds by a "Tilt Buffer" (e.g., 2.0) to fetch extra tiles 
    // so the horizon doesn't disappear when looking forward!
    const tiltBuffer = 2.0; 
    const halfW = (visibleWidth / 2) * tiltBuffer;
    const halfH = (visibleHeight / 2) * tiltBuffer;
    
    return {
      minX: this.controls.target.x - halfW,
      maxX: this.controls.target.x + halfW,
      minY: this.controls.target.y - halfH,
      maxY: this.controls.target.y + halfH
    };
  }

  public render() {
    this.controls.update();
    
    // Update uniforms for TSL using Perspective focal plane math
    const dist = this.camera.position.distanceTo(this.controls.target);
    const fovRad = THREE.MathUtils.degToRad(this.camera.fov);
    const visibleHeight = 2 * Math.tan(fovRad / 2) * dist;
    
    this.worldUnitsPerPixelUniform.value = visibleHeight / window.innerHeight;
    
    // 'zoom' is no longer a property of PerspectiveCamera, so we pass distance as zoom equivalent
    this.zoomUniform.value = 40.0 / dist; 
    this.dprUniform.value = window.devicePixelRatio;
    
    this.renderer.render(this.scene, this.camera);
  }

  public async init() {
    await this.renderer.init();
  }
}
