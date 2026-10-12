// Sediment strata on the block's cut sides: the skirt spans base to bed.
uniform sampler2D uTerrainTex; uniform float uHS, uBaseM;
attribute vec2 aUvT; attribute float aTop, aAlong; attribute vec3 aN;
varying float vHM, vAlong, vTopM; varying vec3 vN, vWorld;
void main(){
  float hTop = texture2D(uTerrainTex, aUvT).r;
  float hM = mix(uBaseM, hTop, aTop);
  vHM = hM; vTopM = hTop; vAlong = aAlong; vN = aN;
  vec3 p = vec3(position.x, hM * uHS, position.z);
  vWorld = p;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
