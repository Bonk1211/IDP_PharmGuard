"use client";

import { Suspense } from "react";
import { Canvas } from "@react-three/fiber";
import {
  ContactShadows,
  useGLTF,
  Bounds,
  Center,
  OrbitControls,
} from "@react-three/drei";

useGLTF.preload("/assem1.glb");

function Model() {
  const { scene } = useGLTF("/assem1.glb");
  return <primitive object={scene} />;
}

function Fallback() {
  return (
    <mesh>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial color="#adb888" />
    </mesh>
  );
}

export default function Model3D({ className = "" }: { className?: string }) {
  return (
    <div className={className}>
      <Canvas
        shadows
        camera={{ position: [3, 2, 4], fov: 35 }}
        dpr={[1, 2]}
        gl={{ antialias: true, alpha: true }}
      >
        <ambientLight intensity={0.7} />
        <hemisphereLight args={["#ffffff", "#d5cfc2", 0.5]} />
        <directionalLight
          position={[5, 6, 4]}
          intensity={1.4}
          castShadow
          shadow-mapSize={[1024, 1024]}
        />
        <directionalLight position={[-4, 3, -2]} intensity={0.6} />
        <directionalLight position={[0, -3, 2]} intensity={0.25} />

        <Suspense fallback={<Fallback />}>
          <Bounds fit clip margin={1.2}>
            <Center>
              <Model />
            </Center>
          </Bounds>
        </Suspense>

        <ContactShadows
          position={[0, -1.2, 0]}
          opacity={0.35}
          scale={8}
          blur={2.4}
          far={3}
        />

        <OrbitControls
          makeDefault
          enablePan={false}
          enableZoom={false}
          rotateSpeed={0.25}
          enableDamping
          dampingFactor={0.04}
          minPolarAngle={Math.PI / 2.6}
          maxPolarAngle={Math.PI / 2.0}
          minAzimuthAngle={-Math.PI / 3}
          maxAzimuthAngle={Math.PI / 3}
        />
      </Canvas>
    </div>
  );
}
