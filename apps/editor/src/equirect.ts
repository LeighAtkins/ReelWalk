/**
 * Equirectangular → Perspective projection renderer using WebGL.
 *
 * Takes a 360° equirectangular panorama and renders it as a perspective
 * view from inside the sphere, like Google Street View.
 *
 * Camera parameters:
 *   yaw   — horizontal look angle (0-360°)
 *   pitch — vertical look angle (-90 to +90°)
 *   fov   — horizontal field of view (30-120°)
 */

const VERTEX_SHADER = `
attribute vec2 a_position;
varying vec2 v_uv;
void main() {
  v_uv = (a_position + 1.0) * 0.5;
  v_uv.y = 1.0 - v_uv.y;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_yaw;    // radians
uniform float u_pitch;  // radians
uniform float u_fov;    // radians
uniform float u_aspect; // width / height
uniform float u_lens;   // lens correction factor (0=none, 1=strong)

#define PI 3.14159265358979

void main() {
  // Screen space → NDC
  vec2 ndc = v_uv * 2.0 - 1.0;

  // Apply lens correction — pulls edge pixels inward, reducing stretch
  float r2 = dot(ndc, ndc);
  vec2 ndcCorrected = ndc * (1.0 + u_lens * r2 * 0.15);

  // Ray direction through each pixel (camera looks down -Z)
  float halfFov = u_fov * 0.5;
  float tanHalfFov = tan(halfFov);

  vec3 ray = normalize(vec3(
    ndcCorrected.x * tanHalfFov * u_aspect,
    ndcCorrected.y * tanHalfFov,
    -1.0
  ));

  // Build rotation matrix: yaw (Y-axis) * pitch (X-axis)
  float cosY = cos(u_yaw), sinY = sin(u_yaw);
  float cosP = cos(u_pitch), sinP = sin(u_pitch);

  // Rotate around Y (yaw), then X (pitch)
  vec3 r;
  r.x = ray.x * cosY - ray.z * sinY;
  r.z = ray.x * sinY + ray.z * cosY;
  r.y = ray.y;

  vec3 r2;
  r2.x = r.x;
  r2.y = r.y * cosP - r.z * sinP;
  r2.z = r.y * sinP + r.z * cosP;

  // Convert 3D direction to equirectangular UV
  float lon = atan(r2.z, r2.x);        // -PI to PI
  float lat = asin(clamp(r2.y, -1.0, 1.0)); // -PI/2 to PI/2

  vec2 eqUv;
  eqUv.x = (lon / PI) * 0.5 + 0.5;   // 0 to 1
  eqUv.y = (lat / (PI * 0.5)) * 0.5 + 0.5; // 0 to 1

  gl_FragColor = texture2D(u_tex, eqUv);
}
`;

export interface EquirectCamera {
  yaw: number;   // degrees, 0-360
  pitch: number; // degrees, -90 to +90
  fov: number;   // degrees, 30-120
}

export class EquirectRenderer {
  private gl: WebGLRenderingContext;
  private program: WebGLProgram;
  private texture: WebGLTexture | null = null;
  private positionBuffer: WebGLBuffer;
  private imageEl: HTMLImageElement | null = null;
  private canvas: HTMLCanvasElement;
  private animFrame: number | null = null;

  // Uniform locations
  private u_yaw: WebGLUniformLocation | null;
  private u_pitch: WebGLUniformLocation | null;
  private u_fov: WebGLUniformLocation | null;
  private u_aspect: WebGLUniformLocation | null;
  private u_tex: WebGLUniformLocation | null;
  private u_lens: WebGLUniformLocation | null;

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl", {
      preserveDrawingBuffer: true,
      premultipliedAlpha: false,
    });
    if (!gl) throw new Error("WebGL not supported");
    this.gl = gl;
    this.canvas = canvas;

    // Compile shaders
    const vs = this.compileShader(gl.VERTEX_SHADER, VERTEX_SHADER);
    const fs = this.compileShader(gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    this.program = gl.createProgram()!;
    gl.attachShader(this.program, vs);
    gl.attachShader(this.program, fs);
    gl.linkProgram(this.program);

    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
      throw new Error("Shader link failed: " + gl.getProgramInfoLog(this.program));
    }

    // Full-screen quad
    this.positionBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1,  1, -1,  -1, 1,
      -1,  1,  1, -1,   1, 1,
    ]), gl.STATIC_DRAW);

    // Uniform locations
    this.u_yaw = gl.getUniformLocation(this.program, "u_yaw");
    this.u_pitch = gl.getUniformLocation(this.program, "u_pitch");
    this.u_fov = gl.getUniformLocation(this.program, "u_fov");
    this.u_aspect = gl.getUniformLocation(this.program, "u_aspect");
    this.u_tex = gl.getUniformLocation(this.program, "u_tex");
    this.u_lens = gl.getUniformLocation(this.program, "u_lens");
  }

  private compileShader(type: number, source: string): WebGLShader {
    const gl = this.gl;
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error("Shader compile failed: " + gl.getShaderInfoLog(shader));
    }
    return shader;
  }

  setImage(image: HTMLImageElement) {
    const gl = this.gl;
    this.imageEl = image;

    if (this.texture) gl.deleteTexture(this.texture);
    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  }

  render(cam: EquirectCamera) {
    const gl = this.gl;
    const w = this.canvas.width;
    const h = this.canvas.height;

    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(this.program);

    // Bind quad
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    const posLoc = gl.getAttribLocation(this.program, "a_position");
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    // Set uniforms
    gl.uniform1f(this.u_yaw, (cam.yaw * Math.PI) / 180);
    gl.uniform1f(this.u_pitch, (cam.pitch * Math.PI) / 180);
    gl.uniform1f(this.u_fov, (cam.fov * Math.PI) / 180);
    gl.uniform1f(this.u_aspect, w / h);
    gl.uniform1f(this.u_lens, 0.5); // mild lens correction to reduce edge stretch

    // Bind texture
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.uniform1i(this.u_tex, 0);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  /**
   * Render a single frame and return the canvas (for chaining or reading pixels).
   * Useful for export pipelines that need frame-by-frame rendering.
   */
  renderFrame(cam: EquirectCamera, width: number, height: number): HTMLCanvasElement {
    this.canvas.width = width;
    this.canvas.height = height;
    this.render(cam);
    return this.canvas;
  }

  dispose() {
    const gl = this.gl;
    if (this.texture) gl.deleteTexture(this.texture);
    gl.deleteBuffer(this.positionBuffer);
    gl.deleteProgram(this.program);
  }
}

/**
 * Create an HTMLImageElement from a URL (promise-based).
 */
export function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load image: ${url}`));
    img.src = url;
  });
}

/**
 * Interpolate camera position between two spherical coordinates.
 * Yaw interpolates directly from start to end (not shortest-path),
 * so a 0°→270° sweep goes the full 270°, not backwards 90°.
 * This is correct for real estate pano sweeps.
 */
export function interpolateCamera(
  start: EquirectCamera,
  end: EquirectCamera,
  t: number,
): EquirectCamera {
  return {
    yaw: ((start.yaw + (end.yaw - start.yaw) * t) % 360 + 360) % 360,
    pitch: start.pitch + (end.pitch - start.pitch) * t,
    fov: start.fov + (end.fov - start.fov) * t,
  };
}

// --- 2D Canvas equirectangular renderer (no WebGL needed) ---

function d2r(d: number) { return d * Math.PI / 180; }

const _srcCanvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
const _outCanvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;

/**
 * Draw an equirectangular pano onto a 2D canvas using perspective projection.
 * For each output pixel, cast a ray through the camera, convert to spherical
 * coords, and sample the source image. No WebGL needed.
 */
export function drawEquirect2D(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  cam: EquirectCamera,
  outW: number,
  outH: number,
  qualityScale = 0.25,
) {
  const srcW = img.naturalWidth;
  const srcH = img.naturalHeight;
  if (!srcW || !srcH || !_srcCanvas || !_outCanvas) return;

  const yaw = d2r(cam.yaw);
  const pitch = d2r(cam.pitch);
  const fov = d2r(cam.fov);
  const aspect = outW / outH;
  const halfFov = fov / 2;
  const tanHalf = Math.tan(halfFov);
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const lensCorr = 0.5; // match WebGL lens correction

  const rw = Math.max(2, Math.floor(outW * qualityScale));
  const rh = Math.max(2, Math.floor(outH * qualityScale));

  // Draw source image to scratch canvas for pixel access
  _srcCanvas.width = srcW;
  _srcCanvas.height = srcH;
  const srcCtx = _srcCanvas.getContext('2d');
  if (!srcCtx) return;
  srcCtx.drawImage(img, 0, 0);
  const srcData = srcCtx.getImageData(0, 0, srcW, srcH);
  const px = srcData.data;

  _outCanvas.width = rw;
  _outCanvas.height = rh;
  const outCtx = _outCanvas.getContext('2d');
  if (!outCtx) return;
  const outImg = outCtx.createImageData(rw, rh);
  const op = outImg.data;

  for (let y = 0; y < rh; y++) {
    const ndcY = (y / rh) * 2 - 1;
    for (let x = 0; x < rw; x++) {
      const ndcX = (x / rw) * 2 - 1;

      // Apply lens correction — pulls edge pixels inward
      const r2 = ndcX * ndcX + ndcY * ndcY;
      const corr = 1 + lensCorr * r2 * 0.15;
      const cx = ndcX * corr;
      const cyN = ndcY * corr;

      let rx = cx * tanHalf * aspect;
      let ry = cyN * tanHalf;
      let rz = -1;
      const rlen = Math.sqrt(rx * rx + ry * ry + rz * rz);
      rx /= rlen; ry /= rlen; rz /= rlen;

      // Yaw (Y axis)
      let tx = rx * cy - rz * sy;
      let ty = ry;
      let tz = rx * sy + rz * cy;

      // Pitch (X axis)
      let fx = tx;
      let fy = ty * cp - tz * sp;
      let fz = ty * sp + tz * cp;

      const lon = Math.atan2(fz, fx);
      const lat = Math.asin(Math.max(-1, Math.min(1, fy)));

      const u = (lon / Math.PI) * 0.5 + 0.5;
      const v = (lat / (Math.PI * 0.5)) * 0.5 + 0.5;

      const sx = Math.floor(u * srcW);
      const sy2 = Math.floor(v * srcH);
      const si = (Math.max(0, Math.min(srcH - 1, sy2)) * srcW + Math.max(0, Math.min(srcW - 1, sx))) * 4;

      const di = (y * rw + x) * 4;
      op[di] = px[si];
      op[di + 1] = px[si + 1];
      op[di + 2] = px[si + 2];
      op[di + 3] = 255;
    }
  }

  outCtx.putImageData(outImg, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(_outCanvas, 0, 0, outW, outH);
}
