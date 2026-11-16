import React, { useEffect, useMemo } from "react";
import { ThreeCanvas } from "@remotion/three";
import { NoToneMapping, PCFSoftShadowMap, SRGBColorSpace } from "three";
import { physicalTextBox, type TextOverlay } from "@reelwalk/core";
import { createPhysicalTextGeometry, physicalTextPlacement } from "./physical-text-geometry";

/** Real solid letters on a manually placed wall proxy. No automatic masking. */
export function PhysicalTitle({text, elapsedMs, width, height}:{text:TextOverlay;elapsedMs:number;width:number;height:number}) {
  const config=text.physical3d!;
  const geometry=useMemo(()=>createPhysicalTextGeometry(text.text,text.size,config),[text.text,text.size,config.depth]);
  useEffect(()=>()=>geometry.dispose(),[geometry]);
  const place=physicalTextPlacement(text.size,config,text.x,text.y,elapsedMs), box=physicalTextBox(text.size);
  const lx=config.light === "left" ? -650 : config.light === "right" ? 650 : 0;
  return <ThreeCanvas width={width} height={height} dpr={1} frameloop="demand" shadows orthographic
    style={{position:"absolute",inset:0,pointerEvents:"none"}}
    camera={{position:[0,0,1400],left:-540,right:540,top:960,bottom:-960,near:1,far:5000}}
    gl={{alpha:true,antialias:true,preserveDrawingBuffer:true}}
    onCreated={({gl})=>{gl.setClearColor(0,0);gl.shadowMap.type=PCFSoftShadowMap;gl.outputColorSpace=SRGBColorSpace;gl.toneMapping=NoToneMapping;}}>
    <ambientLight intensity={.8} color="#fff7ee" />
    <directionalLight position={[lx,1100,1600]} intensity={1.6} color="#fff4e4" castShadow shadow-mapSize-width={1024} shadow-mapSize-height={1024}
      shadow-camera-left={-1100} shadow-camera-right={1100} shadow-camera-top={1600} shadow-camera-bottom={-1600} shadow-camera-near={1} shadow-camera-far={5000} shadow-bias={-.0001} shadow-normalBias={.4}/>
    <group position={[place.x,place.y,0]} rotation={[0,place.pose.tilt,0]}>
      <mesh castShadow position={[0,0,place.pose.z]} rotation={[0,0,place.pose.rotateZ]}>
        <primitive object={geometry} attach="geometry" />
        <meshStandardMaterial attach="material-0" color={text.color} roughness={.8}/>
        <meshStandardMaterial attach="material-1" color="#40342b" roughness={.6}/>
      </mesh>
      <mesh receiveShadow position={[0,0,-28]}><planeGeometry args={[box.width,box.height]}/><shadowMaterial transparent opacity={config.shadow} depthWrite={false}/></mesh>
    </group>
  </ThreeCanvas>;
}
