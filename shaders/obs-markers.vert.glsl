// Observation markers as screen-space points; size is in CSS pixels.
attribute vec3 color; attribute float shape; attribute float size;
uniform float uDpr;
varying vec3 vColor; varying float vShape; varying float vPx; varying float vRim;
void main() {
  vColor = color; vShape = shape;
  gl_PointSize = size * uDpr;
  vPx = 2.0 / max(gl_PointSize, 1.0);
  // a rim of fixed pixel width would eat half of a 6 px survey dot
  vRim = size >= 9.0 ? 1.6 * vPx : 0.0;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
