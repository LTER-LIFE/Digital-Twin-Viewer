// Terrain block surface: the grid plane displaced by bed height x uHS.
uniform sampler2D uTerrainTex; uniform float uHS; uniform vec4 uTexFit;
varying vec2 vUvT; varying vec3 vWorld;
void main(){
  vUvT = uv * uTexFit.xy + uTexFit.zw;
  vec3 p = position;
  p.y = texture2D(uTerrainTex, vUvT).r * uHS;
  vWorld = p;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
