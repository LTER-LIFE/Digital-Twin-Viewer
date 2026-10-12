// Flow trails: one line segment per trail step; aSpeed is the particle's
// current speed in m/s, normalised against uMaxSpeed for the colour ramp.
attribute float aFade, aSpeed;
uniform float uMaxSpeed;
varying float vFade; varying float vT; varying vec3 vWorld;
void main(){
  vFade = aFade;
  vT = clamp(aSpeed / uMaxSpeed, 0.0, 1.0);
  vWorld = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
