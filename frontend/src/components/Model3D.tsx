"use client";

import { Suspense, useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import {
  OrbitControls,
  Environment,
  ContactShadows,
  useGLTF,
  Bounds,
} from "@react-three/drei";
import type { Group } from "three";

useGLTF.preload("/assem1.glb");

function Model({ autoRotate = true }: { autoRotate?: boolean }) {
  const ref = useRef<Group>(null);
  const { scene } = useGLTF("/assem1.glb");

  useFrame((_, delta) => {
    if (autoRotate && ref.current) {
      ref.current.rotation.y += delta * 0.35;
    }
  });

  return (
    <group ref={ref}>
      <primitive object={scene} />
    </group>
  );
}

function Fallback() {
  return (
    <mesh>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial color="#adb888" />
    </mesh>
  );
}

export default function Model3D({
  autoRotate = true,
  className = "",
}: {
  autoRotate?: boolean;
  className?: string;
}) {
  return (
    <div className={className}>
      <Canvas
        shadows
        camera={{ position: [3, 2, 4], fov: 35 }}
        dpr={[1, 2]}
        gl={{ antialias: true, alpha: true }}
      >
        <ambientLight intensity={0.55} />
        <directionalLight
          position={[5, 6, 4]}
          intensity={1.1}
          castShadow
          shadow-mapSize={[1024, 1024]}
        />
        <directionalLight position={[-4, 3, -2]} intensity={0.4} />

        <Suspense fallback={<Fallback />}>
          <Bounds fit clip observe margin={1.2}>
            <Model autoRotate={autoRotate} />
          </Bounds>
          <Environment preset="studio" />
        </Suspense>

        <ContactShadows
          position={[0, -1.2, 0]}
          opacity={0.35}
          scale={8}
          blur={2.4}
          far={3}
        />

        <OrbitControls
          enablePan={false}
          enableZoom={false}
          minPolarAngle={Math.PI / 3.2}
          maxPolarAngle={Math.PI / 2.1}
        />
      </Canvas>
    </div>
  );
}
