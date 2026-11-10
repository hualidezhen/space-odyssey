// 后期处理：Bloom + 电影感调色（暗角 / 胶片颗粒 / 径向色散 / 轻微畸变）
// 所有全屏效果统一在这里做，各场景模块不要自己加全屏后处理。
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const FinishShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uRes: { value: new THREE.Vector2(1920, 1080) },
    uWarp: { value: 0 },
    uGrain: { value: 0.055 },
    uVignette: { value: 1.0 },
    uAberration: { value: 1.0 },
    uFadeToBlack: { value: 0 },
    uHue: { value: 0 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
  `,
  fragmentShader: /* glsl */`
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform float uTime, uWarp, uGrain, uVignette, uAberration, uFadeToBlack, uHue;
    uniform vec2 uRes;
    varying vec2 vUv;

    float hash(vec2 p){
      p = fract(p * vec2(443.897, 441.423));
      p += dot(p, p.yx + 19.19);
      return fract((p.x + p.y) * p.x);
    }

    void main(){
      vec2 uv = vUv;
      vec2 c = uv - 0.5;
      float r2 = dot(c, c);

      // 轻微的镜头桶形畸变
      uv = 0.5 + c * (1.0 + r2 * 0.055);

      // 径向色散（跃迁时放大）
      float ca = (0.0012 + uWarp * 0.016) * uAberration * r2;
      vec2 dir = normalize(c + 1e-6);
      float r = texture2D(tDiffuse, uv - dir * ca).r;
      vec2 ga = texture2D(tDiffuse, uv).ga;
      float b = texture2D(tDiffuse, uv + dir * ca).b;
      vec3 col = vec3(r, ga.x, b);

      // 跃迁时的径向拉伸 + 冷色偏移
      if (uWarp > 0.001) {
        vec3 acc = vec3(0.0); float wsum = 0.0;
        for (int i = 1; i <= 6; i++) {
          float f = float(i) / 6.0;
          vec2 suv = 0.5 + c * (1.0 + uWarp * 0.22 * f);
          float w = 1.0 - f * 0.7;
          acc += texture2D(tDiffuse, suv).rgb * w;
          wsum += w;
        }
        col = mix(col, acc / wsum, uWarp * 0.55);
        col += vec3(0.05, 0.11, 0.2) * uWarp * (0.3 + r2);
      }

      // 冷暖分离调色：暗部压青、亮部留暖
      float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(col, col * vec3(0.93, 1.0, 1.07), (1.0 - smoothstep(0.0, 0.5, lum)) * 0.8);
      col = mix(col, col * vec3(1.05, 1.0, 0.95), smoothstep(0.55, 1.0, lum) * 0.6);
      col = pow(col, vec3(0.98));

      // 胶片颗粒
      float g = hash(uv * uRes + fract(uTime) * 7919.0) - 0.5;
      col += g * uGrain * (0.55 + 0.45 * (1.0 - lum));

      // 暗角
      float vig = smoothstep(0.95, 0.18, length(c) * 1.32);
      col *= mix(1.0, vig, uVignette * 0.85);

      // 黑场过渡
      col *= (1.0 - uFadeToBlack);

      gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    }
  `,
};

export function createPostFX(renderer, scene, camera, opts = {}) {
  const size = new THREE.Vector2();
  renderer.getSize(size);

  const composer = new EffectComposer(renderer);
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.setSize(size.x, size.y);

  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);

  const bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.62, 0.72, 0.62);
  bloom.threshold = opts.threshold ?? 0.62;
  bloom.strength = opts.strength ?? 0.62;
  bloom.radius = opts.radius ?? 0.72;
  composer.addPass(bloom);

  const output = new OutputPass();
  composer.addPass(output);

  const finish = new ShaderPass(FinishShader);
  finish.uniforms.uRes.value.set(size.x, size.y);
  finish.renderToScreen = true;
  composer.addPass(finish);

  return {
    composer,
    bloom,
    finish,
    render(dt) {
      finish.uniforms.uTime.value += dt;
      composer.render(dt);
    },
    setSize(w, h) {
      composer.setSize(w, h);
      finish.uniforms.uRes.value.set(w, h);
    },
    setPixelRatio(r) {
      composer.setPixelRatio(r);
    },
    setWarp(v) { finish.uniforms.uWarp.value = v; },
    setFade(v) { finish.uniforms.uFadeToBlack.value = v; },
    setBloom(amount) { bloom.strength = amount; },
    setGrain(v) { finish.uniforms.uGrain.value = v; },
    // 切换渲染目标：内部漫游 / 行星展厅用各自的 scene + camera
    use(s, c) {
      renderPass.scene = s;
      renderPass.camera = c;
    },
  };
}
