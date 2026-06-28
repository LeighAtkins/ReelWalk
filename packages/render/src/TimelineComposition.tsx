import React, { useRef, useEffect, useState, useMemo } from "react";
import {
  AbsoluteFill,
  Img,
  Video,
  Audio,
  Sequence,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import type { EditorProject, Clip } from "./editor-types";

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
uniform float u_yaw;
uniform float u_pitch;
uniform float u_fov;
uniform float u_aspect;
#define PI 3.14159265358979
void main() {
  vec2 ndc = v_uv * 2.0 - 1.0;
  float halfFov = u_fov * 0.5;
  float tanHalfFov = tan(halfFov);
  vec3 ray = normalize(vec3(
    ndc.x * tanHalfFov * u_aspect,
    ndc.y * tanHalfFov,
    -1.0
  ));
  float cosY = cos(u_yaw), sinY = sin(u_yaw);
  float cosP = cos(u_pitch), sinP = sin(u_pitch);
  vec3 r;
  r.x = ray.x * cosY - ray.z * sinY;
  r.z = ray.x * sinY + ray.z * cosY;
  r.y = ray.y;
  vec3 r2;
  r2.x = r.x;
  r2.y = r.y * cosP - r.z * sinP;
  r2.z = r.y * sinP + r.z * cosP;
  float lon = atan(r2.z, r2.x);
  float lat = asin(clamp(r2.y, -1.0, 1.0));
  vec2 eqUv;
  eqUv.x = (lon / PI) * 0.5 + 0.5;
  eqUv.y = (lat / (PI * 0.5)) * 0.5 + 0.5;
  gl_FragColor = texture2D(u_tex, eqUv);
}
`;

interface CameraParams {
  yaw: number;
  pitch: number;
  fov: number;
}

function interpolateCamera(start: CameraParams, end: CameraParams, t: number): CameraParams {
  let dyaw = end.yaw - start.yaw;
  if (dyaw > 180) dyaw -= 360;
  if (dyaw < -180) dyaw += 360;
  return {
    yaw: ((start.yaw + dyaw * t) % 360 + 360) % 360,
    pitch: start.pitch + (end.pitch - start.pitch) * t,
    fov: start.fov + (end.fov - start.fov) * t,
  };
}

/**
 * Equirectangular pano clip — WebGL spherical projection (Street View style).
 */
const PanoClip: React.FC<{ clip: Clip }> = ({ clip }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const glRef = useRef<WebGLRenderingContext | null>(null);
  const programRef = useRef<WebGLProgram | null>(null);
  const textureRef = useRef<WebGLTexture | null>(null);
  const bufferRef = useRef<WebGLBuffer | null>(null);
  const [imageLoaded, setImageLoaded] = useState(false);
  const imgRef = useRef<HTMLImageElement | null>(null);

  const camera = useMemo<CameraParams>(() => {
    const startAngle = clip.panStartAngle ?? 0;
    const endAngle = clip.panEndAngle ?? 90;
    const startPitch = clip.startPitch ?? 0;
    const endPitch = clip.endPitch ?? 0;
    const startFov = clip.fov ?? 75;
    const endFov = clip.endFov ?? startFov;
    const progress = clip.durationFrames > 1 ? frame / (clip.durationFrames - 1) : 0;
    return interpolateCamera(
      { yaw: startAngle, pitch: startPitch, fov: startFov },
      { yaw: endAngle, pitch: endPitch, fov: endFov },
      progress,
    );
  }, [clip, frame]);

  // Init GL
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl", { preserveDrawingBuffer: true });
    if (!gl) return;
    glRef.current = gl;

    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    };
    const vs = compile(gl.VERTEX_SHADER, VERTEX_SHADER);
    const fs = compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    programRef.current = prog;

    const buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1,
    ]), gl.STATIC_DRAW);
    bufferRef.current = buf;

    return () => {
      gl.deleteProgram(prog);
      gl.deleteBuffer(buf);
      if (textureRef.current) gl.deleteTexture(textureRef.current);
    };
  }, []);

  // Load image
  useEffect(() => {
    if (!clip.assetUrl) return;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      imgRef.current = img;
      setImageLoaded(true);
    };
    img.src = clip.assetUrl;
  }, [clip.assetUrl]);

  // Upload texture
  useEffect(() => {
    const gl = glRef.current;
    if (!gl || !imgRef.current || !programRef.current) return;
    if (textureRef.current) gl.deleteTexture(textureRef.current);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, imgRef.current);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    textureRef.current = tex;
  }, [imageLoaded]);

  // Render
  useEffect(() => {
    const gl = glRef.current;
    const prog = programRef.current;
    const buf = bufferRef.current;
    const tex = textureRef.current;
    if (!gl || !prog || !buf || !tex) return;

    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(prog);

    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    const posLoc = gl.getAttribLocation(prog, "a_position");
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    gl.uniform1f(gl.getUniformLocation(prog, "u_yaw"), (camera.yaw * Math.PI) / 180);
    gl.uniform1f(gl.getUniformLocation(prog, "u_pitch"), (camera.pitch * Math.PI) / 180);
    gl.uniform1f(gl.getUniformLocation(prog, "u_fov"), (camera.fov * Math.PI) / 180);
    gl.uniform1f(gl.getUniformLocation(prog, "u_aspect"), width / height);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(gl.getUniformLocation(prog, "u_tex"), 0);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }, [camera, imageLoaded, width, height]);

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      <canvas ref={canvasRef} width={width} height={height} style={{ width: "100%", height: "100%" }} />
    </AbsoluteFill>
  );
};

const ClipRenderer: React.FC<{ clip: Clip }> = ({ clip }) => {
  if (clip.type === "video") {
    return (
      <AbsoluteFill>
        <Video src={clip.assetUrl} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      </AbsoluteFill>
    );
  }
  if (clip.type === "image") {
    return (
      <AbsoluteFill>
        <Img src={clip.assetUrl} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      </AbsoluteFill>
    );
  }
  if (clip.type === "pano") return <PanoClip clip={clip} />;
  if (clip.type === "text") {
    return (
      <AbsoluteFill style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "0 60px" }}>
        <span style={{
          fontSize: clip.fontSize ?? 64,
          color: clip.color ?? "#fff",
          fontWeight: 700,
          textAlign: "center",
          textShadow: "0 4px 12px rgba(0,0,0,0.6)",
          fontFamily: "system-ui, -apple-system, sans-serif",
        }}>
          {clip.text ?? ""}
        </span>
      </AbsoluteFill>
    );
  }
  if (clip.type === "audio") return <Audio src={clip.assetUrl} />;
  return null;
};

export interface TimelineCompositionProps {
  project: EditorProject;
}

export const TimelineComposition: React.FC<TimelineCompositionProps> = ({ project }) => {
  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      {project.tracks.map((track) => {
        if (!track.visible) return null;
        return track.clips.map((clip) => (
          <Sequence key={clip.id} from={clip.startFrame} durationInFrames={clip.durationFrames} name={clip.name}>
            <ClipRenderer clip={clip} />
          </Sequence>
        ));
      })}
    </AbsoluteFill>
  );
};
