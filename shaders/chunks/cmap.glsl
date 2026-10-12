// Colormap lookup for the variable drape. uCmapTex is the 256x1 LUT built by
// colormaps.js; CMAP_LUT_SCALE / CMAP_LUT_OFFSET come in as material defines
// (CMAP_DEFINES in colormaps.js) so the texel-centre mapping follows LUT_N.
uniform sampler2D uCmapTex;
vec3 applyCmap(float t){
  float x = clamp(t, 0.0, 1.0) * CMAP_LUT_SCALE + CMAP_LUT_OFFSET;
  return texture2D(uCmapTex, vec2(x, 0.5)).rgb;
}
