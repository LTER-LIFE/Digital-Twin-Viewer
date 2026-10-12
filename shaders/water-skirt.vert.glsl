// Translucent water side walls: the skirt spans bed to water level, and
// collapses where the edge cell is dry.
uniform sampler2D uTerrainTex, uElevA, uElevB; uniform float uHS, uMix;
attribute vec2 aUvT; attribute float aTop; attribute vec3 aN;
varying float vYM, vLevel, vBed; varying vec3 vN, vWorld;
void main(){
  float h = texture2D(uTerrainTex, aUvT).r;
  float lv = mix(texture2D(uElevA, aUvT).r, texture2D(uElevB, aUvT).r, uMix);
  lv = max(lv, h);                    // collapse where dry
  float yM = mix(h, lv, aTop);
  vYM = yM; vLevel = lv; vBed = h; vN = aN;
  vec3 p = vec3(position.x, yM * uHS + 0.012, position.z);
  vWorld = p;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
