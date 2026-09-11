"use client";

import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { StemName, STEM_NAMES, STEM_CONFIGS, Position3D } from '../hooks/useSpatialSession';
import { haloVertexShader } from './shaders/haloVertex.glsl';
import { haloFragmentShader } from './shaders/haloFragment.glsl';

interface SpatialCanvas3DProps {
    positions: Record<StemName, Position3D>;
    activeStem: StemName;
    rmsLevels: Record<StemName, number>;
    onSelectStem: (stem: StemName) => void;
    onUpdatePosition: (stem: StemName, x: number, y: number, z: number) => void;
}

export const SpatialCanvas3D: React.FC<SpatialCanvas3DProps> = ({
    positions,
    activeStem,
    rmsLevels,
    onSelectStem,
    onUpdatePosition
}) => {
    const mountRef = useRef<HTMLDivElement>(null);
    const sceneRef = useRef<THREE.Scene | null>(null);
    const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
    const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
    const controlsRef = useRef<OrbitControls | null>(null);

    // References to stem objects and shader materials
    const stemNodesRef = useRef<Map<StemName, THREE.Group>>(new Map());
    const haloMaterialsRef = useRef<Map<StemName, THREE.ShaderMaterial>>(new Map());
    const dropLinesRef = useRef<Map<StemName, THREE.Line>>(new Map());

    // Dragging interaction state
    const draggingStemRef = useRef<StemName | null>(null);
    const dragPlaneRef = useRef<THREE.Plane>(new THREE.Plane());
    const raycasterRef = useRef<THREE.Raycaster>(new THREE.Raycaster());
    const pointerRef = useRef<THREE.Vector2>(new THREE.Vector2());

    // Props ref to access latest handlers inside Three.js event loop
    const propsRef = useRef({ onSelectStem, onUpdatePosition, activeStem, rmsLevels, positions });
    propsRef.current = { onSelectStem, onUpdatePosition, activeStem, rmsLevels, positions };

    useEffect(() => {
        const container = mountRef.current;
        if (!container) return;

        // 1. Scene & Coordinates (Audio coordinate convention: +X Right, +Y Forward, +Z Up)
        const scene = new THREE.Scene();
        sceneRef.current = scene;
        scene.fog = new THREE.FogExp2(0x0a0d14, 0.08);

        // 2. Camera: Positioned behind and slightly above listener
        const width = container.clientWidth;
        const height = container.clientHeight;
        const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
        camera.up.set(0, 0, 1); // Z is Up
        camera.position.set(0, -4.8, 3.2); // Looking from behind (-Y) and above (+Z) towards origin
        camera.lookAt(0, 0.5, 0);
        cameraRef.current = camera;

        // 3. High-Fidelity WebGL Renderer
        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
        renderer.setSize(width, height);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.2;
        container.appendChild(renderer.domElement);
        rendererRef.current = renderer;

        // 4. OrbitControls
        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.05;
        controls.maxDistance = 8.0;
        controls.minDistance = 1.5;
        controls.maxPolarAngle = Math.PI / 2 + 0.1; // Limit below ground plane
        controls.target.set(0, 0.5, 0);
        controlsRef.current = controls;

        // 5. Lighting
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
        scene.add(ambientLight);

        const keyLight = new THREE.DirectionalLight(0x00f2fe, 1.2);
        keyLight.position.set(3, -4, 5);
        scene.add(keyLight);

        const fillLight = new THREE.DirectionalLight(0x9d4edd, 0.8);
        fillLight.position.set(-3, 4, 3);
        scene.add(fillLight);

        // 6. Soundstage Ground: Concentric Distance Rings (0.5m to 3.0m)
        const gridGroup = new THREE.Group();
        const ringDistances = [0.5, 1.0, 1.5, 2.0, 2.5, 3.0];
        const ringMaterial = new THREE.LineBasicMaterial({ color: 0x334155, transparent: true, opacity: 0.4 });

        ringDistances.forEach(radius => {
            const segments = 64;
            const points: THREE.Vector3[] = [];
            for (let i = 0; i <= segments; ++i) {
                const theta = (i / segments) * Math.PI * 2;
                points.push(new THREE.Vector3(Math.cos(theta) * radius, Math.sin(theta) * radius, 0));
            }
            const ringGeo = new THREE.BufferGeometry().setFromPoints(points);
            const ringLine = new THREE.Line(ringGeo, ringMaterial);
            gridGroup.add(ringLine);
        });

        // Stage boundary wireframe sphere (3.0m radius)
        const stageSphereGeo = new THREE.SphereGeometry(3.0, 24, 16);
        const stageSphereMat = new THREE.MeshBasicMaterial({
            color: 0x00f2fe,
            wireframe: true,
            transparent: true,
            opacity: 0.04
        });
        const stageSphere = new THREE.Mesh(stageSphereGeo, stageSphereMat);
        gridGroup.add(stageSphere);

        // Directional Axes (X Right: Red/Cyan, Y Forward: Blue/Green)
        const axisGeoY = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, -3, 0), new THREE.Vector3(0, 3, 0)]);
        const axisMatY = new THREE.LineBasicMaterial({ color: 0x00f2fe, transparent: true, opacity: 0.5 });
        gridGroup.add(new THREE.Line(axisGeoY, axisMatY));

        const axisGeoX = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-3, 0, 0), new THREE.Vector3(3, 0, 0)]);
        const axisMatX = new THREE.LineBasicMaterial({ color: 0x475569, transparent: true, opacity: 0.3 });
        gridGroup.add(new THREE.Line(axisGeoX, axisMatX));

        scene.add(gridGroup);

        // 7. Central Listener Avatar at (0, 0, 0)
        const listenerGroup = new THREE.Group();

        // Head Sphere
        const headGeo = new THREE.SphereGeometry(0.18, 32, 32);
        const headMat = new THREE.MeshStandardMaterial({
            color: 0x1e293b,
            metalness: 0.9,
            roughness: 0.15,
            emissive: 0x0f172a
        });
        const headMesh = new THREE.Mesh(headGeo, headMat);
        listenerGroup.add(headMesh);

        // Directional Cone (Facing +Y forward)
        const coneGeo = new THREE.ConeGeometry(0.09, 0.28, 16);
        coneGeo.rotateX(Math.PI / 2); // Point along +Y
        const coneMat = new THREE.MeshStandardMaterial({
            color: 0x00f2fe,
            emissive: 0x00f2fe,
            emissiveIntensity: 0.8,
            roughness: 0.2
        });
        const coneMesh = new THREE.Mesh(coneGeo, coneMat);
        coneMesh.position.set(0, 0.24, 0);
        listenerGroup.add(coneMesh);

        // Binaural Ear Markers
        const earGeo = new THREE.SphereGeometry(0.04, 16, 16);
        const earMat = new THREE.MeshStandardMaterial({ color: 0x00f2fe, emissive: 0x00f2fe });
        const leftEar = new THREE.Mesh(earGeo, earMat);
        leftEar.position.set(-0.18, 0, 0); // Left (-X)
        const rightEar = new THREE.Mesh(earGeo, earMat);
        rightEar.position.set(0.18, 0, 0);  // Right (+X)
        listenerGroup.add(leftEar);
        listenerGroup.add(rightEar);

        scene.add(listenerGroup);

        // 8. Construct 4 Stem Orbital Nodes with Dynamic GLSL Pulsing Halos
        STEM_NAMES.forEach(stem => {
            const config = STEM_CONFIGS[stem];
            const nodeGroup = new THREE.Group();
            nodeGroup.name = stem;

            // Core Stem Sphere
            const coreGeo = new THREE.SphereGeometry(0.12, 32, 32);
            const coreMat = new THREE.MeshStandardMaterial({
                color: config.hexInt,
                emissive: config.hexInt,
                emissiveIntensity: 0.6,
                metalness: 0.4,
                roughness: 0.3
            });
            const coreMesh = new THREE.Mesh(coreGeo, coreMat);
            coreMesh.userData = { stemName: stem };
            nodeGroup.add(coreMesh);

            // Dynamic GLSL Pulsing Halo
            const haloGeo = new THREE.SphereGeometry(0.24, 32, 32);
            const haloMat = new THREE.ShaderMaterial({
                vertexShader: haloVertexShader,
                fragmentShader: haloFragmentShader,
                uniforms: {
                    uColor: { value: new THREE.Color(config.color) },
                    uTime: { value: 0.0 },
                    uRms: { value: 0.1 }
                },
                transparent: true,
                blending: THREE.AdditiveBlending,
                side: THREE.BackSide,
                depthWrite: false
            });
            const haloMesh = new THREE.Mesh(haloGeo, haloMat);
            nodeGroup.add(haloMesh);
            haloMaterialsRef.current.set(stem, haloMat);

            // Drop line to ground plane
            const dropLineGeo = new THREE.BufferGeometry().setFromPoints([
                new THREE.Vector3(0, 0, 0),
                new THREE.Vector3(0, 0, 0)
            ]);
            const dropLineMat = new THREE.LineBasicMaterial({
                color: config.hexInt,
                transparent: true,
                opacity: 0.35
            });
            const dropLine = new THREE.Line(dropLineGeo, dropLineMat);
            scene.add(dropLine);
            dropLinesRef.current.set(stem, dropLine);

            // Initial position
            const initialPos = propsRef.current.positions[stem];
            nodeGroup.position.set(initialPos.x, initialPos.y, initialPos.z);
            scene.add(nodeGroup);
            stemNodesRef.current.set(stem, nodeGroup);
        });

        // 9. Pointer Raycasting & Drag Interaction
        const onPointerDown = (event: MouseEvent) => {
            const rect = renderer.domElement.getBoundingClientRect();
            pointerRef.current.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
            pointerRef.current.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

            raycasterRef.current.setFromCamera(pointerRef.current, camera);

            // Intersect stem meshes
            const stemMeshes = Array.from(stemNodesRef.current.values()).map(g => g.children[0]);
            const intersects = raycasterRef.current.intersectObjects(stemMeshes, false);

            if (intersects.length > 0) {
                const hit = intersects[0];
                const stemName = hit.object.userData.stemName as StemName;
                if (stemName) {
                    draggingStemRef.current = stemName;
                    propsRef.current.onSelectStem(stemName);

                    // Disable camera rotation while dragging
                    controls.enabled = false;

                    // Create camera-facing drag plane intersecting the stem position
                    const stemPos = stemNodesRef.current.get(stemName)!.position;
                    const planeNormal = new THREE.Vector3();
                    camera.getWorldDirection(planeNormal).negate();
                    dragPlaneRef.current.setFromNormalAndCoplanarPoint(planeNormal, stemPos);
                }
            }
        };

        const onPointerMove = (event: MouseEvent) => {
            const rect = renderer.domElement.getBoundingClientRect();
            pointerRef.current.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
            pointerRef.current.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

            if (draggingStemRef.current) {
                raycasterRef.current.setFromCamera(pointerRef.current, camera);
                const intersection = new THREE.Vector3();

                if (raycasterRef.current.ray.intersectPlane(dragPlaneRef.current, intersection)) {
                    propsRef.current.onUpdatePosition(
                        draggingStemRef.current,
                        intersection.x,
                        intersection.y,
                        intersection.z
                    );
                }
            } else {
                // Hover effect: change cursor
                raycasterRef.current.setFromCamera(pointerRef.current, camera);
                const stemMeshes = Array.from(stemNodesRef.current.values()).map(g => g.children[0]);
                const intersects = raycasterRef.current.intersectObjects(stemMeshes, false);
                renderer.domElement.style.cursor = intersects.length > 0 ? 'grab' : 'default';
            }
        };

        const onPointerUp = () => {
            if (draggingStemRef.current) {
                draggingStemRef.current = null;
                controls.enabled = true;
                renderer.domElement.style.cursor = 'default';
            }
        };

        const domElem = renderer.domElement;
        domElem.addEventListener('mousedown', onPointerDown);
        window.addEventListener('mousemove', onPointerMove);
        window.addEventListener('mouseup', onPointerUp);

        // 10. ResizeObserver for responsive resizing
        const resizeObserver = new ResizeObserver(() => {
            if (!container || !rendererRef.current || !cameraRef.current) return;
            const newW = container.clientWidth;
            const newH = container.clientHeight;
            cameraRef.current.aspect = newW / newH;
            cameraRef.current.updateProjectionMatrix();
            rendererRef.current.setSize(newW, newH);
        });
        resizeObserver.observe(container);

        // 11. Animation Loop
        let animationFrameId: number;
        const clock = new THREE.Clock();

        const animate = () => {
            animationFrameId = requestAnimationFrame(animate);
            const elapsedTime = clock.getElapsedTime();

            controls.update();

            // Update positions and dynamic GLSL shader uniforms
            STEM_NAMES.forEach(stem => {
                const nodeGroup = stemNodesRef.current.get(stem);
                const haloMat = haloMaterialsRef.current.get(stem);
                const dropLine = dropLinesRef.current.get(stem);
                const pos = propsRef.current.positions[stem];
                const rms = propsRef.current.rmsLevels[stem] || 0.05;

                if (nodeGroup && pos) {
                    nodeGroup.position.set(pos.x, pos.y, pos.z);

                    // Update drop line geometry from node down to Z=0
                    if (dropLine) {
                        const points = [
                            new THREE.Vector3(pos.x, pos.y, pos.z),
                            new THREE.Vector3(pos.x, pos.y, 0)
                        ];
                        dropLine.geometry.setFromPoints(points);
                    }

                    // Highlight active stem with subtle scale pulse
                    const isActive = propsRef.current.activeStem === stem;
                    const scaleFactor = (isActive ? 1.15 : 1.0) * (1.0 + rms * 0.4);
                    nodeGroup.scale.set(scaleFactor, scaleFactor, scaleFactor);
                }

                // Update GLSL shader uniforms
                if (haloMat) {
                    haloMat.uniforms.uTime.value = elapsedTime;
                    haloMat.uniforms.uRms.value = rms;
                }
            });

            renderer.render(scene, camera);
        };

        animate();

        // Cleanup
        return () => {
            cancelAnimationFrame(animationFrameId);
            resizeObserver.disconnect();
            domElem.removeEventListener('mousedown', onPointerDown);
            window.removeEventListener('mousemove', onPointerMove);
            window.removeEventListener('mouseup', onPointerUp);
            renderer.dispose();
            if (domElem.parentElement) {
                domElem.parentElement.removeChild(domElem);
            }
        };
    }, []);

    return (
        <div 
            ref={mountRef} 
            style={{ 
                width: '100%', 
                height: '100%', 
                position: 'relative', 
                overflow: 'hidden',
                borderRadius: '24px'
            }} 
        />
    );
};
