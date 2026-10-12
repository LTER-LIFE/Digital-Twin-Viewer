// Terrain block surface: realistic or analysis colouring, satellite drape on
// land, wet-sand memory, the optional variable drape, lighting and fog.
uniform sampler2D uTerrainTex, uElevA, uElevB, uWet, uSatTex, uSatUV, uVarA, uVarB;
uniform float uHS, uMix, uTime, uMode, uHasSat, uBright, uVarOn;
uniform vec3 uSunDir;
uniform vec2 uGrid, uCell;
varying vec2 vUvT; varying vec3 vWorld;
#include "chunks/noise.glsl"
#include "chunks/sky.glsl"
#include "chunks/fog.glsl"
#include "chunks/cmap.glsl"
#include "chunks/varmap.glsl"
void main(){
  vec4 data = texture2D(uTerrainTex, vUvT);
  float h = data.r, landF = smoothstep(0.35, 0.7, data.g), inter = data.b;
  float level = mix(texture2D(uElevA, vUvT).r, texture2D(uElevB, vUvT).r, uMix);
  float depth = level - h;
  vec2 wet2 = texture2D(uWet, vUvT).rg;

  // --- normal from height field ---
  vec2 tx = 1.0 / uGrid;
  float hx0 = texture2D(uTerrainTex, vUvT - vec2(tx.x,0.)).r;
  float hx1 = texture2D(uTerrainTex, vUvT + vec2(tx.x,0.)).r;
  float hy0 = texture2D(uTerrainTex, vUvT - vec2(0.,tx.y)).r;
  float hy1 = texture2D(uTerrainTex, vUvT + vec2(0.,tx.y)).r;
  vec3 tX = vec3(2.0*uCell.x, (hx1-hx0)*uHS, 0.0);
  vec3 tZ = vec3(0.0, (hy1-hy0)*uHS, -2.0*uCell.y);
  vec3 nrm = normalize(cross(tX, tZ));

  vec2 wxz = vWorld.xz;
  float n1 = fbm(wxz*0.16), n2 = fbm(wxz*0.55 + 7.3), n3 = fbm(wxz*2.6 + 3.1);

  vec3 c;
  float lake = 0.0;
  if (uMode < 0.5) {
    // ------------- realistic -------------
    vec3 deepBed = vec3(0.13,0.16,0.17);
    vec3 midBed  = vec3(0.40,0.35,0.25);
    vec3 sandDry = vec3(0.84,0.77,0.59);
    vec3 grass   = vec3(0.30,0.43,0.20);
    vec3 dune    = vec3(0.80,0.74,0.57);
    c = mix(deepBed, midBed, smoothstep(-14.0, -3.0, h));
    c = mix(c, sandDry, smoothstep(-1.5, 1.3, h));
    c *= 0.90 + 0.18*n1;                       // large patchiness
    c *= 0.96 + 0.08*n3;                       // fine grain
    // land: real satellite imagery when available, else procedural meadows
    vec3 landCol;
    if (uHasSat > 0.5) {
      vec2 suv = texture2D(uSatUV, vUvT).rg;
      vec3 sat = texture2D(uSatTex, suv).rgb;
      // inland water renders near-black in the imagery — recolor as lake
      float slum = dot(sat, vec3(0.299, 0.587, 0.114));
      lake = smoothstep(0.020, 0.006, slum) * landF;
      vec3 lakeC = mix(vec3(0.055,0.115,0.135), vec3(0.10,0.19,0.18), n1);
      landCol = mix(sat * 1.32, lakeC, lake);
    } else {
      landCol = grass * (0.88 + 0.22*n1);
      landCol = mix(landCol, grass*vec3(0.82,0.9,0.7), smoothstep(0.45,0.7,n2)*0.6);
      float duneRing = smoothstep(4.2, 2.4, h) * smoothstep(0.30, 0.55, n2);
      landCol = mix(landCol, dune, duneRing);
      landCol *= 0.94 + 0.10*n3;
    }
    c = mix(c, landCol, landF);
    // wet sand: darker where recently under water & now exposed
    float exposedNow = 1.0 - smoothstep(0.0, 0.04, depth);
    float wetDark = wet2.r * exposedNow * (1.0 - landF);
    c = mix(c, c*vec3(0.50,0.49,0.47), wetDark*0.9);
    // dark waterline band
    c *= 1.0 - 0.22*(1.0-landF)*exp(-abs(depth)*9.0);
    // ripple marks on flats
    float rip = sin(dot(wxz, vec2(9.0, 4.0)) + n1*12.0)*0.5+0.5;
    c *= 1.0 - 0.05*rip*(1.0-landF)*smoothstep(0.4,0.0,abs(h))* wetDark;
  } else {
    // ------------- analysis -------------
    vec3 seaC   = vec3(0.16,0.20,0.25);
    vec3 landC  = vec3(0.30,0.33,0.28);
    vec3 flatC  = vec3(0.62,0.57,0.44);
    vec3 wetC   = vec3(0.12,0.48,0.85);
    vec3 driedC = vec3(1.00,0.48,0.15);
    vec3 floodC = vec3(0.15,1.00,0.75);
    float isWet = smoothstep(-0.01, 0.01, depth);
    c = mix(flatC, seaC, (1.0-inter)*isWet);
    c = mix(c, wetC, inter*isWet);
    float dried = inter * (1.0-isWet) * wet2.r;
    c = mix(c, driedC, dried);
    c = mix(c, floodC, inter*isWet*wet2.g);
    c = mix(c, landC, landF);
    c *= 0.9 + 0.2*n3;
  }

  // --- variable drape: color the sea/flats by the field, keep land as the real-world map ---
  if (uVarOn > 0.5) {
    float raw = mix(texture2D(uVarA, vUvT).r, texture2D(uVarB, vUvT).r, uMix);
    vec3 fieldCol = applyCmap(clamp(varPosition(raw), 0.0, 1.0));
    c = mix(fieldCol, c, landF);   // sea -> colormap, land -> existing terrain / satellite color
  }

  c *= uBright;

  // --- lighting ---
  vec3 L = uSunDir;
  float dif = max(dot(nrm, L), 0.0);
  vec3 amb = mix(vec3(0.24,0.22,0.20), vec3(0.42,0.50,0.58), nrm.y*0.5+0.5);
  vec3 V = normalize(cameraPosition - vWorld);
  vec3 col;
  if (uVarOn > 0.5) {
    // flat shading on the colored field so the colormap reads true;
    // land keeps realistic lighting so the map stays legible
    vec3 flatCol = c * (0.72 + 0.42*dif);
    vec3 litCol  = c * (amb + vec3(1.0,0.94,0.82)*dif*1.15);
    col = mix(flatCol, litCol, landF);
    // keep inland-water sheen so lakes still read as water on the map
    if (lake > 0.0) {
      col = mix(col, skyColor(reflect(-V, nrm), uSunDir), lake * 0.30);
      col += vec3(1.0,0.95,0.85) * pow(max(dot(nrm, normalize(L+V)),0.0), 140.0) * lake * 0.7;
    }
  } else {
    col = c * (amb + vec3(1.0,0.94,0.82)*dif*1.15);
    // wet sand specular
    float wetSpec = texture2D(uWet, vUvT).r * (1.0 - smoothstep(0.0, 0.04, depth)) * (1.0-landF);
    col += vec3(1.0,0.95,0.85) * pow(max(dot(nrm, normalize(L+V)),0.0), 48.0) * wetSpec * 0.5;
    // lakes: sky reflection sheen + sun glint so they read as water
    if (lake > 0.0) {
      col = mix(col, skyColor(reflect(-V, nrm), uSunDir), lake * 0.30);
      col += vec3(1.0,0.95,0.85) * pow(max(dot(nrm, normalize(L+V)),0.0), 140.0) * lake * 0.7;
    }
    // underwater attenuation of the bed
    if (depth > 0.0 && uMode < 0.5) col *= exp(-depth * vec3(0.22, 0.12, 0.08));
  }

  col = applyFog(col, vWorld);
  gl_FragColor = vec4(col, 1.0);
}
