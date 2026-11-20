// High-performance GPU video color-grading & multi-color selective HSL renderer (WebGL 1.0).
// Runs ALL color filters (lighting, brightness, contrast, saturation, dynamics, temperature,
// global hue, tint, vignette) + up to 8 simultaneous selective HSL color bands in ONE GPU pass
// directly in VRAM, with zero texture re-uploads while paused.
import { hexToRgb, rgbToHsl, getHslBands, isBandActive, MAX_HSL_BANDS } from './color.js';
import * as T from './timeline.js';

const MAX_PREVIEW_W = 1920;
const MAX_PREVIEW_H = 1080;

const VERT = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = vec2((a_pos.x + 1.0) * 0.5, 1.0 - (a_pos.y + 1.0) * 0.5);
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

const FRAG = `
precision mediump float;
uniform sampler2D u_tex;
uniform vec4 u_colorA; // (brightnessMul, contrastMul, satMul, globalHueShift)
uniform vec4 u_colorB; // (temperature, tint, vignette, sharpenBoost)
uniform int u_count;
uniform vec4 u_bandA[8]; // (targetHue, range, shiftH, shiftS)
uniform float u_bandL[8]; // shiftL
varying vec2 v_uv;

vec3 rgb2hsl(vec3 c) {
  float maxC = max(c.r, max(c.g, c.b));
  float minC = min(c.r, min(c.g, c.b));
  float l = (maxC + minC) * 0.5;
  float d = maxC - minC;
  if (d < 0.0001) return vec3(0.0, 0.0, l);
  float s = l > 0.5 ? d / (2.0 - maxC - minC) : d / (maxC + minC);
  float h = 0.0;
  if (maxC == c.r) h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0);
  else if (maxC == c.g) h = (c.b - c.r) / d + 2.0;
  else h = (c.r - c.g) / d + 4.0;
  return vec3(h / 6.0, s, l);
}

float hue2rgb(float p, float q, float t) {
  if (t < 0.0) t += 1.0;
  if (t > 1.0) t -= 1.0;
  if (t < 1.0 / 6.0) return p + (q - p) * 6.0 * t;
  if (t < 0.5) return q;
  if (t < 2.0 / 3.0) return p + (q - p) * (2.0 / 3.0 - t) * 6.0;
  return p;
}

vec3 hsl2rgb(vec3 hsl) {
  if (hsl.y < 0.0001) return vec3(hsl.z);
  float q = hsl.z < 0.5 ? hsl.z * (1.0 + hsl.y) : hsl.z + hsl.y - hsl.z * hsl.y;
  float p = 2.0 * hsl.z - q;
  return vec3(
    hue2rgb(p, q, hsl.x + 1.0 / 3.0),
    hue2rgb(p, q, hsl.x),
    hue2rgb(p, q, hsl.x - 1.0 / 3.0)
  );
}

void main() {
  vec4 tex = texture2D(u_tex, v_uv);
  vec3 rgb = tex.rgb;

  // 1. Multi-color selective HSL (up to 8 target colors)
  if (u_count > 0) {
    vec3 orig = rgb2hsl(rgb);
    float satMask = smoothstep(0.04, 0.14, orig.y);
    if (satMask > 0.001) {
      float dH = 0.0;
      float dS = 0.0;
      float dL = 0.0;
      float anyW = 0.0;
      for (int i = 0; i < 8; i++) {
        if (i >= u_count) break;
        vec4 b = u_bandA[i];
        float diff = abs(orig.x - b.x);
        diff = min(diff, 1.0 - diff);
        float w = (1.0 - smoothstep(b.y * 0.35, b.y, diff)) * satMask;
        if (w > 0.001) {
          dH += b.z * w;
          dS += b.w * w;
          dL += u_bandL[i] * w;
          anyW = max(anyW, w);
        }
      }
      if (anyW > 0.001) {
        rgb = hsl2rgb(vec3(fract(orig.x + dH), clamp(orig.y + dS, 0.0, 1.0), clamp(orig.z + dL, 0.0, 1.0)));
      }
    }
  }

  // 2. Global color grading (brightness/lighting, contrast/dynamics, saturation, temperature, tint, global hue)
  rgb *= u_colorA.x;
  rgb = (rgb - 0.5) * u_colorA.y + 0.5;
  float luma = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
  rgb = mix(vec3(luma), rgb, u_colorA.z);

  // Temperature (warm R / cool B) & Tint (magenta / green)
  rgb.r += u_colorB.x * 0.12;
  rgb.b -= u_colorB.x * 0.12;
  rgb.g -= u_colorB.y * 0.09;
  rgb = clamp(rgb, 0.0, 1.0);

  if (abs(u_colorA.w) > 0.001) {
    vec3 gh = rgb2hsl(rgb);
    gh.x = fract(gh.x + u_colorA.w);
    rgb = hsl2rgb(gh);
  }

  // 3. Vignette
  if (u_colorB.z > 0.005) {
    vec2 d = v_uv - 0.5;
    float dist = length(d) * 1.4142;
    float vig = smoothstep(0.45, 1.15, dist) * u_colorB.z * 0.9;
    rgb *= (1.0 - vig);
  }

  gl_FragColor = vec4(clamp(rgb, 0.0, 1.0), tex.a);
}
`;

export function createHslRenderer() {
  const canvas = document.createElement('canvas');
  canvas.className = 'program-gl';
  canvas.hidden = true;

  let gl = null;
  let locs = null;
  let tex = null;
  let failed = false;
  let gpuName = '';
  let lastSrc = '';
  let lastTime = -1;
  let hasUploaded = false;

  const bandABuf = new Float32Array(MAX_HSL_BANDS * 4);
  const bandLBuf = new Float32Array(MAX_HSL_BANDS);

  function initGl() {
    if (gl || failed) return Boolean(gl);
    gl = canvas.getContext('webgl', {
      powerPreference: 'high-performance',
      antialias: false,
      depth: false,
      stencil: false,
      alpha: false,
      desynchronized: true,
      preserveDrawingBuffer: false,
    });
    if (!gl) { failed = true; return false; }

    try {
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      gpuName = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '') : String(gl.getParameter(gl.RENDERER) || '');
    } catch {
      gpuName = '';
    }

    const compile = (type, src) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) return null;
      return sh;
    };
    const vs = compile(gl.VERTEX_SHADER, VERT);
    const fs = compile(gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) { failed = true; gl = null; return false; }

    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { failed = true; gl = null; return false; }
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const posLoc = gl.getAttribLocation(prog, 'a_pos');
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    locs = {
      colorA: gl.getUniformLocation(prog, 'u_colorA'),
      colorB: gl.getUniformLocation(prog, 'u_colorB'),
      count: gl.getUniformLocation(prog, 'u_count'),
      bandA: gl.getUniformLocation(prog, 'u_bandA'),
      bandL: gl.getUniformLocation(prog, 'u_bandL'),
    };
    return true;
  }

  function render(video, clip) {
    if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return false;
    if (!initGl()) return false;

    const scale = Math.min(1, MAX_PREVIEW_W / video.videoWidth, MAX_PREVIEW_H / video.videoHeight);
    const targetW = Math.max(2, Math.round(video.videoWidth * scale));
    const targetH = Math.max(2, Math.round(video.videoHeight * scale));
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
      gl.viewport(0, 0, canvas.width, canvas.height);
      hasUploaded = false;
    }

    // Keep the frame texture in VRAM; only re-upload when playing or when frame/src changed.
    const needsUpload = !hasUploaded || !video.paused || video.src !== lastSrc || Math.abs(video.currentTime - lastTime) > 0.001;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (needsUpload) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
      lastSrc = video.src;
      lastTime = video.currentTime;
      hasUploaded = true;
    }

    const brightMul = Math.max(0.05, (T.propValue(clip, 'brightness') / 50) + (T.propValue(clip, 'exposure') / 100) * 0.5);
    const contrastMul = Math.max(0.1, (T.propValue(clip, 'contrast') / 50) + (T.propValue(clip, 'dynamics') / 100) * 0.35 + (T.propValue(clip, 'sharpen') / 100) * 0.18);
    const satMul = Math.max(0, (T.propValue(clip, 'saturation') / 50) + (T.propValue(clip, 'dynamics') / 100) * 0.25);
    const globalHue = T.propValue(clip, 'hue') / 360;
    const temp = T.propValue(clip, 'temperature') / 100;
    const tint = T.propValue(clip, 'tint') / 100;
    const vig = T.propValue(clip, 'vignette') / 100;
    const sharpen = T.propValue(clip, 'sharpen') / 100;

    const active = getHslBands(clip).filter(isBandActive).slice(0, MAX_HSL_BANDS);
    for (let i = 0; i < active.length; i++) {
      const b = active[i];
      const rgb = hexToRgb(b.hex) || { r: 239, g: 68, b: 68 };
      const { h } = rgbToHsl(rgb.r, rgb.g, rgb.b);
      const rangeDeg = typeof b.range === 'number' ? b.range : 35;
      bandABuf[i * 4 + 0] = h / 360;
      bandABuf[i * 4 + 1] = Math.max(0.02, Math.min(0.45, rangeDeg / 360));
      bandABuf[i * 4 + 2] = (Math.round(Number(b.hue) || 0)) / 360;
      bandABuf[i * 4 + 3] = (Math.round(Number(b.sat) || 0)) / 100;
      bandLBuf[i] = (Math.round(Number(b.light) || 0)) / 100;
    }

    gl.uniform4f(locs.colorA, brightMul, contrastMul, satMul, globalHue);
    gl.uniform4f(locs.colorB, temp, tint, vig, sharpen);
    gl.uniform1i(locs.count, active.length);
    gl.uniform4fv(locs.bandA, bandABuf);
    gl.uniform1fv(locs.bandL, bandLBuf);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return true;
  }

  function getGpuInfo() {
    initGl();
    return gpuName || (failed ? 'WebGL unavailable' : 'WebGL');
  }

  return { canvas, render, getGpuInfo };
}
