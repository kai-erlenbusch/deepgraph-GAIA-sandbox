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

  private raycaster = new THREE.Raycaster();
  private mouse = new THREE.Vector2();
  private plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);

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
    // Allow full 360 degree rotation (remove maxPolarAngle restriction)
    this.controls.maxPolarAngle = Math.PI; 
    
    // Disable native zoom so we can implement custom Zoom-to-Mouse
    this.controls.enableZoom = false;
    
    // Reset mouse buttons to standard 3D orbit controls
    this.controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN
    };

    window.addEventListener('resize', this.onWindowResize.bind(this));
    this.renderer.domElement.addEventListener('wheel', this.onWheel.bind(this), { passive: false });
  }

  private onWheel(event: WheelEvent) {
    event.preventDefault(); // Prevent page scroll
    
    // 1. Raycast to Z=0 plane to find the 3D point the mouse is hovering over
    this.mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
    this.mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
    this.raycaster.setFromCamera(this.mouse, this.camera);
    
    const intersection = new THREE.Vector3();
    if (this.raycaster.ray.intersectPlane(this.plane, intersection)) {
      // 2. Calculate zoom factor
      const zoomFactor = event.deltaY > 0 ? 1.1 : 0.9;
      
      // Prevent zooming so close that WebGPU Float32 precision breaks down!
      const currentDist = this.camera.position.distanceTo(this.controls.target);
      if (zoomFactor < 1.0 && currentDist < 0.2) {
        return;
      }
      
      const alpha = 1 - zoomFactor;
      
      // 3. Move camera and target perfectly towards (or away from) the mouse intersection
      this.camera.position.lerp(intersection, alpha);
      this.controls.target.lerp(intersection, alpha);
    }
  }

  public set2DMode(is2D: boolean) {
    if (is2D) {
      this.controls.enableRotate = false;
      this.controls.mouseButtons.LEFT = THREE.MOUSE.PAN;
      // Snap to perfect top-down view
      this.camera.position.set(this.controls.target.x, this.controls.target.y, 50.0);
    } else {
      this.controls.enableRotate = true;
      this.controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
      // Tilt back to 45 degree angle
      this.camera.position.set(this.controls.target.x, this.controls.target.y - 20.0, 50.0);
    }
    this.controls.update();
  }

  private onWindowResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
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
