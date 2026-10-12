// Sky dome, pinned to the far plane (xyww) so it never occludes the scene.
varying vec3 vDir;
void main(){
  vDir = position;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = (projectionMatrix * mv).xyww;
}
