"use client";

import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { StemName, STEM_NAMES, STEM_CONFIGS, Position3D } from '../hooks/useSpatialSession';
import { haloVertexShader } from './shaders/haloVertex.glsl';
import {
    haloFragmentShader,
    floorVertexShader,
    floorFragmentShader,
    wavefrontVertexShader,
    wavefrontFragmentShader
} from './shaders/haloFragment.glsl';

const STAGE_R = 3.0;   // stage boundary, metres
const NEAR_R = 0.5;    // near-field clamp, metres
const WAVE_SPEED = 2.4; // metres/second, scaled for legibility

interface SpatialCanvas3DProps {
    positions: Record<StemName, Position3D>;
    activeStem: StemName;
    levels: Record<StemName, number>;
    onSelectStem: (stem: StemName) => void;
    onUpdatePosition: (stem: StemName, x: number, y: number, z: number) => void;
    onFirstMove?: () => void;
}

interface StemRig {
    group: THREE.Group;
    core: THREE.Mesh;
    shell: THREE.Mesh;
    shellMat: THREE.ShaderMaterial;
    drop: THREE.Line;
    dropPos: THREE.BufferAttribute;
    wave: THREE.Mesh;
    waveMat: THREE.ShaderMaterial;
    waveProgress: number;
    waveStrength: number;
    waveDistance: number;
    last: THREE.Vector3;
}

export const SpatialCanvas3D: React.FC<SpatialCanvas3DProps> = React.memo(({
    positions,
    activeStem,
    levels,
    onSelectStem,
    onUpdatePosition,
    onFirstMove
}) => {
    const mountRef = useRef<HTMLDivElement>(null);

    // Latest props, read from inside the render loop without re-running the effect.
    const propsRef = useRef({ positions, activeStem, levels, onSelectStem, onUpdatePosition, onFirstMove });
    propsRef.current = { positions, activeStem, levels, onSelectStem, onUpdatePosition, onFirstMove };

    useEffect(() => {
        const container = mountRef.current;
        if (!container) return;

        const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const disposables: { dispose(): void }[] = [];
        const track = <T extends { dispose(): void }>(o: T): T => { disposables.push(o); return o; };

        let width = container.clientWidth || 1;
        let height = container.clientHeight || 1;

        // ---------------------------------------------------------------
        // Renderer. Linear workflow with ACES so that bright, saturated
        // emitters desaturate toward white the way real ones do.
        // ---------------------------------------------------------------
        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
        renderer.setSize(width, height);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 0.95;
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.setClearColor(0x06080b, 1);
        container.appendChild(renderer.domElement);

        const scene = new THREE.Scene();
        scene.fog = new THREE.FogExp2(0x06080b, 0.055);

        // +X right, +Y forward, +Z up — the DSP's own convention.
        const camera = new THREE.PerspectiveCamera(40, width / height, 0.1, 60);
        camera.up.set(0, 0, 1);
        camera.position.set(0.55, -4.85, 3.95);

        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.06;
        controls.rotateSpeed = 0.75;
        controls.minDistance = 1.8;
        controls.maxDistance = 8.5;
        controls.maxPolarAngle = Math.PI * 0.495;  // never go under the floor
        controls.minPolarAngle = 0.12;
        controls.target.set(0, 0.05, 0.15);
        controls.update();

        // ---------------------------------------------------------------
        // Post: one bloom pass, tuned low. Bloom is what turns an emissive
        // material into light; without it the scene reads as bright plastic.
        // ---------------------------------------------------------------
        const composer = track(new EffectComposer(renderer));
        composer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
        composer.setSize(width, height);
        composer.addPass(new RenderPass(scene, camera));

        const bloom = new UnrealBloomPass(new THREE.Vector2(width, height), 0.62, 0.62, 0.72);
        composer.addPass(bloom);
        composer.addPass(new OutputPass());

        // ---------------------------------------------------------------
        // Lighting. Deliberately dim: almost everything visible here is an
        // emitter, and the lights exist only to shape the listener.
        // ---------------------------------------------------------------
        scene.add(new THREE.AmbientLight(0x3d4a63, 1.5));

        const key = new THREE.DirectionalLight(0xdbeaff, 2.1);
        key.position.set(2.4, -3.0, 4.2);
        scene.add(key);

        const rim = new THREE.DirectionalLight(0x6f9bff, 1.1);
        rim.position.set(-3.2, 2.6, 1.4);
        scene.add(rim);

        // ---------------------------------------------------------------
        // Floor graticule — computed in the shader so the rings stay crisp
        // at any zoom and dissolve at the edges instead of cutting off.
        // ---------------------------------------------------------------
        const floorGeo = track(new THREE.PlaneGeometry(STAGE_R * 2.3, STAGE_R * 2.3));
        const floorMat = track(new THREE.ShaderMaterial({
            vertexShader: floorVertexShader,
            fragmentShader: floorFragmentShader,
            uniforms: {
                uGrid: { value: new THREE.Color(0x46566c) },
                uEdge: { value: new THREE.Color(0x7f97b2) },
                uOuter: { value: STAGE_R },
                uInner: { value: NEAR_R }
            },
            transparent: true,
            depthWrite: false
            // No THREE fog here: a raw ShaderMaterial with fog:true needs the
            // fog uniforms and chunks merged in by hand. The grid already
            // dissolves analytically at the stage edge, which is the effect
            // fog would have been faking.
        }));
        scene.add(new THREE.Mesh(floorGeo, floorMat));

        // The forward axis, drawn once. It is the 0° bearing and the only
        // reason the listener's orientation is readable at all.
        const axisGeo = track(new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(0, 0, 0.004), new THREE.Vector3(0, STAGE_R, 0.004)
        ]));
        const axisMat = track(new THREE.LineBasicMaterial({ color: 0x8fa6c2, transparent: true, opacity: 0.75 }));
        scene.add(new THREE.Line(axisGeo, axisMat));

        // ---------------------------------------------------------------
        // Listener. A measurement head: matte, unlit from within, facing +Y.
        // ---------------------------------------------------------------
        const listener = new THREE.Group();

        const headGeo = track(new THREE.SphereGeometry(0.135, 48, 32));
        headGeo.scale(0.92, 1.06, 1.12);
        const headMat = track(new THREE.MeshStandardMaterial({
            color: 0x51627b, metalness: 0.08, roughness: 0.7,
            emissive: 0x141b26, emissiveIntensity: 1.0
        }));
        listener.add(new THREE.Mesh(headGeo, headMat));

        // The two receivers. Everything in this app exists to serve these.
        const earGeo = track(new THREE.CylinderGeometry(0.024, 0.024, 0.016, 20));
        earGeo.rotateZ(Math.PI / 2);
        const earMat = track(new THREE.MeshStandardMaterial({
            color: 0x8fe6ff, emissive: 0x8fe6ff, emissiveIntensity: 0.9, roughness: 0.4
        }));
        const earL = new THREE.Mesh(earGeo, earMat);
        earL.position.set(-0.131, 0, 0);
        const earR = new THREE.Mesh(earGeo, earMat);
        earR.position.set(0.131, 0, 0);
        listener.add(earL, earR);

        // Nose: a small flat wedge, not a cone. Reads as an instrument datum
        // rather than an arrow.
        const noseGeo = track(new THREE.ConeGeometry(0.024, 0.075, 3));
        noseGeo.rotateX(-Math.PI / 2);
        const noseMat = track(new THREE.MeshStandardMaterial({
            color: 0x4a5a72, metalness: 0.3, roughness: 0.5
        }));
        const nose = new THREE.Mesh(noseGeo, noseMat);
        nose.position.set(0, 0.15, -0.008);
        listener.add(nose);

        scene.add(listener);

        // ---------------------------------------------------------------
        // Stems
        // ---------------------------------------------------------------
        const rigs = new Map<StemName, StemRig>();
        const coreGeo = track(new THREE.SphereGeometry(0.058, 32, 24));
        const shellGeo = track(new THREE.SphereGeometry(0.17, 40, 28));
        const waveGeo = track(new THREE.PlaneGeometry(2, 2));

        STEM_NAMES.forEach(stem => {
            const cfg = STEM_CONFIGS[stem];
            const hue = new THREE.Color(cfg.color);

            const group = new THREE.Group();
            group.name = stem;

            // Core driven well past 1.0 so ACES + bloom blow the centre out
            // to white and leave the hue in the skirt. White core, coloured
            // falloff — for free, from the tone mapper.
            const lum = 0.2126 * hue.r + 0.7152 * hue.g + 0.0722 * hue.b;
            const drive = 1.62 / Math.max(0.18, lum);
            const coreMat = track(new THREE.MeshBasicMaterial({
                color: hue.clone().multiplyScalar(drive), toneMapped: true
            }));
            const core = new THREE.Mesh(coreGeo, coreMat);
            core.userData.stemName = stem;
            group.add(core);

            const shellMat = track(new THREE.ShaderMaterial({
                vertexShader: haloVertexShader,
                fragmentShader: haloFragmentShader,
                uniforms: {
                    uColor: { value: hue.clone() },
                    uLevel: { value: 0.1 },
                    uSelected: { value: 0 }
                },
                transparent: true,
                blending: THREE.AdditiveBlending,
                side: THREE.BackSide,
                depthWrite: false,
                fog: false
            }));
            const shell = new THREE.Mesh(shellGeo, shellMat);
            group.add(shell);

            // Drop line to the floor, faded toward the bottom via vertex
            // colours. Its buffer is written in place every frame — never
            // reallocated.
            const dropGeo = track(new THREE.BufferGeometry());
            const dropPos = new THREE.BufferAttribute(new Float32Array(6), 3);
            dropPos.setUsage(THREE.DynamicDrawUsage);
            dropGeo.setAttribute('position', dropPos);
            dropGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array([
                hue.r, hue.g, hue.b, hue.r * 0.06, hue.g * 0.06, hue.b * 0.06
            ]), 3));
            const dropMat = track(new THREE.LineBasicMaterial({
                vertexColors: true, transparent: true, opacity: 0.9
            }));
            const drop = new THREE.Line(dropGeo, dropMat);
            drop.frustumCulled = false;
            scene.add(drop);

            // Wavefront, lying flat on the measurement floor.
            const waveMat = track(new THREE.ShaderMaterial({
                vertexShader: wavefrontVertexShader,
                fragmentShader: wavefrontFragmentShader,
                uniforms: {
                    uColor: { value: hue.clone() },
                    uProgress: { value: 1 },
                    uRadius: { value: 1 },
                    uStrength: { value: 0 }
                },
                transparent: true,
                blending: THREE.AdditiveBlending,
                depthWrite: false,
                side: THREE.DoubleSide,
                fog: false
            }));
            const wave = new THREE.Mesh(waveGeo, waveMat);
            wave.position.z = 0.006;
            wave.visible = false;
            scene.add(wave);

            const p = propsRef.current.positions[stem];
            group.position.set(p.x, p.y, p.z);
            scene.add(group);

            rigs.set(stem, {
                group, core, shell, shellMat, drop, dropPos, wave, waveMat,
                waveProgress: 1, waveStrength: 0, waveDistance: 1,
                last: new THREE.Vector3(p.x, p.y, p.z)
            });
        });

        // ---------------------------------------------------------------
        // Pointer interaction. Pointer events, so this works under touch.
        // ---------------------------------------------------------------
        const raycaster = new THREE.Raycaster();
        raycaster.params.Points = { threshold: 0.1 };
        const ndc = new THREE.Vector2();
        const dragPlane = new THREE.Plane();
        const hitPoint = new THREE.Vector3();
        const planeNormal = new THREE.Vector3();
        const pickables: THREE.Object3D[] = [];
        rigs.forEach(r => pickables.push(r.core));

        let dragging: StemName | null = null;
        let announcedMove = false;
        const el = renderer.domElement;
        el.style.touchAction = 'none';

        const toNdc = (e: PointerEvent) => {
            const rect = el.getBoundingClientRect();
            ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
            ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        };

        const onDown = (e: PointerEvent) => {
            toNdc(e);
            raycaster.setFromCamera(ndc, camera);
            const hit = raycaster.intersectObjects(pickables, false)[0];
            if (!hit) return;

            const stem = hit.object.userData.stemName as StemName;
            if (!stem) return;

            dragging = stem;
            propsRef.current.onSelectStem(stem);
            controls.enabled = false;
            el.setPointerCapture(e.pointerId);
            el.style.cursor = 'grabbing';

            camera.getWorldDirection(planeNormal).negate();
            dragPlane.setFromNormalAndCoplanarPoint(planeNormal, rigs.get(stem)!.group.position);
        };

        const onMove = (e: PointerEvent) => {
            toNdc(e);
            raycaster.setFromCamera(ndc, camera);

            if (dragging) {
                if (raycaster.ray.intersectPlane(dragPlane, hitPoint)) {
                    if (!announcedMove) {
                        announcedMove = true;
                        propsRef.current.onFirstMove?.();
                    }
                    propsRef.current.onUpdatePosition(dragging, hitPoint.x, hitPoint.y, hitPoint.z);
                }
                return;
            }
            el.style.cursor = raycaster.intersectObjects(pickables, false).length ? 'grab' : 'default';
        };

        const onUp = (e: PointerEvent) => {
            if (!dragging) return;
            dragging = null;
            controls.enabled = true;
            el.style.cursor = 'grab';
            if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
        };

        el.addEventListener('pointerdown', onDown);
        el.addEventListener('pointermove', onMove);
        el.addEventListener('pointerup', onUp);
        el.addEventListener('pointercancel', onUp);

        // ---------------------------------------------------------------
        // Resize
        // ---------------------------------------------------------------
        const ro = new ResizeObserver(() => {
            width = container.clientWidth || 1;
            height = container.clientHeight || 1;
            camera.aspect = width / height;
            camera.updateProjectionMatrix();
            renderer.setSize(width, height);
            composer.setSize(width, height);
            bloom.setSize(width, height);
        });
        ro.observe(container);

        // ---------------------------------------------------------------
        // Loop. No allocation past this point.
        // ---------------------------------------------------------------
        const clock = new THREE.Clock();
        const tmp = new THREE.Vector3();
        let raf = 0;

        const frame = () => {
            raf = requestAnimationFrame(frame);
            const dt = Math.min(clock.getDelta(), 0.05);
            const { positions: pos, activeStem: sel, levels: lv } = propsRef.current;

            controls.update();

            rigs.forEach((rig, stem) => {
                const p = pos[stem];
                if (!p) return;
                const level = Math.min(1, Math.max(0, lv[stem] ?? 0.05));

                rig.group.position.set(p.x, p.y, p.z);

                // Shell responds to signal and selection, not to a clock.
                rig.shellMat.uniforms.uLevel.value = level;
                rig.shellMat.uniforms.uSelected.value = stem === sel ? 1 : 0;

                const s = 1 + level * 0.22 + (stem === sel ? 0.1 : 0);
                rig.shell.scale.setScalar(s);
                rig.core.scale.setScalar(1 + level * 0.3);

                // Drop line, written in place.
                const a = rig.dropPos.array as Float32Array;
                a[0] = p.x; a[1] = p.y; a[2] = p.z;
                a[3] = p.x; a[4] = p.y; a[5] = 0;
                rig.dropPos.needsUpdate = true;

                if (reduceMotion) return;

                // A move launches a wavefront. Travel time is proportional to
                // distance, so the ring lands on the listener when the sound
                // would — the delay the convolver is actually applying.
                tmp.set(p.x, p.y, p.z);
                if (tmp.distanceTo(rig.last) > 0.012 && rig.waveProgress > 0.22) {
                    rig.waveProgress = 0;
                    rig.waveStrength = 1;
                    rig.waveDistance = Math.max(0.45, Math.hypot(p.x, p.y));
                }
                rig.last.copy(tmp);

                if (rig.waveStrength > 0.001) {
                    rig.waveProgress += (WAVE_SPEED / rig.waveDistance) * dt;
                    if (rig.waveProgress >= 1) {
                        rig.waveProgress = 1;
                        rig.waveStrength = 0;
                        rig.wave.visible = false;
                    } else {
                        rig.wave.visible = true;
                        rig.wave.position.set(p.x, p.y, 0.006);
                        rig.wave.scale.setScalar(rig.waveDistance);
                        rig.waveMat.uniforms.uProgress.value = rig.waveProgress;
                        rig.waveMat.uniforms.uRadius.value = 1;
                        rig.waveMat.uniforms.uStrength.value = rig.waveStrength * (0.5 + level * 0.9);
                    }
                }
            });

            composer.render();
        };
        frame();

        // ---------------------------------------------------------------
        // Teardown. Every geometry, material and target created above.
        // ---------------------------------------------------------------
        return () => {
            cancelAnimationFrame(raf);
            ro.disconnect();
            el.removeEventListener('pointerdown', onDown);
            el.removeEventListener('pointermove', onMove);
            el.removeEventListener('pointerup', onUp);
            el.removeEventListener('pointercancel', onUp);
            controls.dispose();
            bloom.dispose();
            disposables.forEach(d => d.dispose());
            renderer.dispose();
            if (el.parentElement) el.parentElement.removeChild(el);
        };
    }, []);

    return <div ref={mountRef} style={{ position: 'absolute', inset: 0 }} />;
});

SpatialCanvas3D.displayName = 'SpatialCanvas3D';
