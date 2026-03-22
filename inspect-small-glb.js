const { GLTFLoader } = require('three/examples/jsm/loaders/GLTFLoader.js');
const { readFileSync } = require('fs');
const { join } = require('path');

// Read the GLB file
const glbPath = join(__dirname, 'public/modules/small_full.glb');
const glbData = readFileSync(glbPath);

// Create a mock THREE environment
global.THREE = require('three');

const loader = new GLTFLoader();

// Parse the GLB
loader.parse(glbData.buffer, '', (gltf) => {
  console.log('\n=== SMALL_FULL.GLB Structure ===\n');
  
  const scene = gltf.scene;
  const groups = [];
  
  function traverseScene(obj, depth = 0) {
    const indent = '  '.repeat(depth);
    
    if (obj.name && obj.type) {
      console.log(`${indent}${obj.type}: "${obj.name}"`);
      
      if (obj.type === 'Group' || obj.type === 'Object3D' || obj.type === 'Mesh') {
        if (obj.name && obj.name.trim() !== '') {
          groups.push(obj.name);
        }
      }
    }
    
    if (obj.children && obj.children.length > 0) {
      obj.children.forEach(child => traverseScene(child, depth + 1));
    }
  }
  
  traverseScene(scene);
  
  console.log('\n=== Named Groups (Total: ' + groups.length + ') ===');
  groups.forEach((name, idx) => {
    console.log(`${idx + 1}. ${name}`);
  });
  
}, (error) => {
  console.error('Error parsing GLB:', error);
});
