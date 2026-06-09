import * as THREE from 'three';
import { Fn, instanceIndex, atomicAdd, uint, storage } from 'three/tsl';
import { StorageInstancedBufferAttribute } from 'three/webgpu';
import WebGPURenderer from 'three/src/renderers/webgpu/WebGPURenderer.js';

const renderer = new WebGPURenderer();

const visibleIndicesAttr = new StorageInstancedBufferAttribute(new Uint32Array(100), 1);
const visibleIndicesNode = storage(visibleIndicesAttr, 'uint', 100);

const visibleCountAttr = new StorageInstancedBufferAttribute(new Uint32Array(1), 1);
const visibleCountNodeAtomic = storage(visibleCountAttr, 'uint', 1).toAtomic();

const computeNode = Fn(() => {
    const idx = atomicAdd(visibleCountNodeAtomic.element(0), uint(1));
    visibleIndicesNode.element(idx).assign(instanceIndex);
})().compute(100);

async function run() {
    try {
        await renderer.init();
        renderer.compute(computeNode);
        console.log('Compute succeeded!');
    } catch (e) {
        console.error('Compute failed:', e);
    }
}
run();
