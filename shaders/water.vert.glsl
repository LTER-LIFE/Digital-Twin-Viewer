// Water sheet: the grid plane lifted to the interpolated water level.
uniform sampler2D uElevA, uElevB; uniform float uHS, uMix; uniform vec4 uTexFit;
varying vec2 vUvT; varying vec3 vWorld; varying float vLevel;
void main(){
  vUvT = uv * uTexFit.xy + uTexFit.zw;
  vLevel = mix(texture2D(uElevA, vUvT).r, texture2D(uElevB, vUvT).r, uMix);
  vec3 p = position;
  p.y = vLevel * uHS + 0.015;
  vWorld = p;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
