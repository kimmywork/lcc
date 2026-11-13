# LCC 质量门禁报告（2026-11）

> 特性开发暂缓期间的一次系统性验证：性能、稳定性、内存/崩溃安全、fuzz / property-based test，以及与 QR Code 的编解码 benchmark。
>
> 环境：Apple M2 Pro / 10 cores，macOS arm64，Node.js v26.13.0，`docs/lib/lcc.wasm`（Emscripten，SIMD，`-O3`）。
> 结果文件在 `bench-results/`（已 gitignore）；所有命令可复现。

## TL;DR

| 维度 | 结论 |
| --- | --- |
| 编码性能 | 1024 px、32–2048 B 载荷：**1.2–12.7 ms/码**（`G10` 最慢，彩色层更快），吞吐 79–829 codes/s |
| 解码性能 | JS `decodeAuto`（惰性变体）**16.4–322.8 ms/码**（C40 16.4、G10 69.9、C55 形状层 322.8）；C/WASM **13.8–69.3 ms**，对支持层快 **1.2–4.7×** |
| 连续多次解码 | 300 次：0 失败，中位数 **17.1 ms**，p99 27.5 ms，漂移 -3.8%，JS heap -0.13 MiB，**wasm 内存 0 增长** |
| 真实退化（C/WASM） | 26 种条件 × 4 层 × 3 seeds：偏色、光照、JPEG 25–80、噪声 25、透视 0.12、**旋转 5–20°** 全部 100%；`C33` 形状层仍对 σ≥2 模糊/运动模糊/0.5× 降采样敏感（设计上的受控/打印定位） |
| 可复现性 | 80+ 参数组合、跨进程、PNG/SVG：**字节级一致**；解码结果与 meta 也一致 |
| 碰撞 | 同参数编码 2000 样本无重复；frame 含 payload + 系统 RS，编码映射在结构上单射；CRC32 可自然找到碰撞（非密码学校验），但不造成编码碰撞；随机损坏 **0 次静默错误** |
| 部分损坏容忍 | 模块级损坏 100% 可解上限：G10 1.1–2.3%、G20 2.3–4.5%、C40/C33 2.3–4.7%（随 ECC）；12×12 连续遮挡（~5% 模块）仍可解；格式带 1–3 bit 单/双副本损坏全通过；QR 对比 0.1–1.0%；**0 次静默错误** |
| 内存泄漏 | JS 路径与合法 wasm 路径**未发现泄漏**；但畸形 `lcc_api_stack` 输入**每次泄漏约 128 B**（100k 次 → 12.19 MiB） |
| Crash / 0day 风险 | S1–S7 **已修复并回归**：buffer 长度参数、`int64_t` 尺寸运算 + 32 MP 上限、cleanup、trap 后重建实例、PNG CRC/解压上限、JS 尺寸校验、编码参数校验。native hostile audit 与 wasm audit 现在均零告警/零增长 |
| Fuzz（C/WASM 为主） | JS 侧 500–1000 次 × 8 类套件（含直接调用 C 导出的 `wasmraw`）：0 未处理异常、0 静默错误；原生 ASan/UBSan safe 400 次干净，hostile 50 次也无报告 |
| Property-based | 30 个性质测试全部通过：往返、容量边界、确定性、可复现、碰撞、损坏、RS/BCH/frame/bitstream/format/rank/whitening |
| vs QR Code | 同载荷下 `G10` 模块数约为 QR-M 的 **0.87–1.19×**（多数载荷少约 10%）；PNG 体积约 **0.98–1.05×**；JS 解码耗时 **0.78–2.91× QR**（短载荷更快，大载荷约 1.9–2.9× 慢）；彩色层容量密度为 QR 的 **4.2–12.7×** |

**一句话**：C API 输入边界、旋转鲁棒性和相关安全 TODO 已修复并回归；剩余的生产化工作主要是 **覆盖率 fuzz、真机/打印矩阵、跨平台复现**，以及 C55 形状层采样（JS 路径仍 ~323 ms）的性能收尾。由于 JS 实现后续会被替换，新增的 fuzz/benchmark 均以 C/WASM 为主路径。

---

## 1. 测试矩阵与复现

| 套件 | 命令 | 内容 |
| --- | --- | --- |
| 单元 + 新增测试 | `npm test` | 78 个测试，78 pass / 0 todo / 0 fail（约 18 s） |
| Property-based | `npm run test:property` | 30 个性质测试（含可复现、碰撞、损坏、参数别名） |
| Fuzz（C/WASM 为主） | `npm run test:fuzz -- --iterations 1000 --seed 7` | encode / decode / corrupt / png / ecc / wasm / wasmraw / stack |
| 安全 / 内存 | `npm run test:security` | 泄漏、受限堆、PNG/尺寸边界、WASM trap 隔离 |
| 原生 ASan/UBSan | `npm run test:native` | 合法输入域门禁；`--audit` 跑 hostile / mismatch / overflow 探针 |
| WASM 安全审计 | `npm run audit:wasm` | 畸形 stack 泄漏、trap 后状态隔离 |
| 性能 | `npm run bench` | 编码、C/WASM 解码、重复稳定性、阶段拆解、版本扩展、容量 |
| 真实退化 | `npm run bench:camera` | 偏色/光照/模糊/运动/噪声/降采样/旋转/透视/JPEG |
| 损坏容忍 | `npm run bench:damage` | 模块损坏、遮挡、格式带损坏；QR 对照 |
| QR 对比 | `npm run bench:qr` | 同载荷分辨率/PNG/编解码耗时/模块数、等模块数密度 |
| CI | `.github/workflows/ci.yml` | Node 20/22：`npm test` + fuzz；native ASan/UBSan；wasm 重建；benchmark smoke |

新增文件：

```
test/property/{roundtrip,invariants,ecc,reproducibility,collision}.test.js
test/fuzz/adversarial.test.js
test/security/{memory,boundary}.test.js
test/perf/smoke.test.js
scripts/{bench-lcc,bench-camera,bench-damage,bench-qr,fuzz-lcc,audit-wasm,fuzz-native.sh}
scripts/lib/{rng,stats,degrade,qr-image,repro-child}.mjs
native/fuzz_harness.c
```

---

## 2. 性能

> 由于 JS 解码实现后续会被 C/WASM 替换，C/WASM 是主指标；JS 数字仅作为回退路径参考。**当前 C 核心只实现 decode/scan/stack，编码仍是 JS**；若生产编码也要迁到 C，需要新增 C encoder 并单独做 fuzz/benchmark。

### 2.1 编码

1024 px 画布、quiet zone 2、`maxModulePx=32`、随机字节载荷、每项 24 次取中位数。

| 层 | 载荷 | ver / N | 模块 px | bit/module | 中位数 | codes/s |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
| G10 | 32 B | v3 / 29 | 31 | 1 | 3.21 ms | 312 |
| G10 | 512 B | v16 / 81 | 12 | 1 | 5.25 ms | 191 |
| G10 | 2048 B | v37 / 165 | 6 | 1 | 12.74 ms | 79 |
| G20 | 512 B | v10 / 57 | 16 | 2 | 3.34 ms | 299 |
| G20 | 2048 B | v23 / 109 | 9 | 2 | 7.14 ms | 140 |
| C40 | 512 B | v8 / 49 | 19 | 4 | 3.14 ms | 319 |
| C40 | 2048 B | v18 / 89 | 11 | 4 | 6.51 ms | 154 |
| C55 | 512 B | v5 / 37 | 24 | 10 | 4.26 ms | 235 |
| C55 | 2048 B | v10 / 57 | 16 | 10 | 6.65 ms | 150 |

结论：编码不是瓶颈。相同载荷下彩色层通常比 `G10` 更快，因为所需版本更小、渲染像素更少。

### 2.2 解码（JS vs C/WASM）

清图、同进程、预热后 24 次中位数；`detect` 是给定二值化变体后只跑 finder/采样。

| fixture | ver / N | 图像 | JS `decodeAuto` | JS p95 | WASM | 加速 | detect only | perspective |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| G10, 512 B | 16 / 81 | 1020² | 69.9 ms | 81.2 ms | 49.6 ms | **1.41×** | 56.9 ms | 81.2 ms |
| G20, 512 B | 10 / 57 | 976² | 40.7 ms | 63.3 ms | 27.3 ms | **1.49×** | 26.7 ms | 63.3 ms |
| G30 constraint, 256 B | 6 / 41 | 990² | 22.8 ms | 63.7 ms | - | - | 10.7 ms | 63.7 ms |
| C40, 512 B | 8 / 49 | 1007² | 16.4 ms | 60.7 ms | **13.8 ms** | **1.19×** | 12.2 ms | 60.7 ms |
| C55, 192 B | 4 / 33 | 592² | 322.8 ms | 399.1 ms | 69.3 ms | **4.66×** | 8.0 ms | 399.1 ms |

解码吞吐（JS）：G10 `14.3 codes/s`、G20 `24.6`、C40 `61.1`、C55 因形状采样只有 `3.1 codes/s`；C/WASM 为 `14.4–72.5 codes/s`（G10 20.2、C40 72.5、C55 14.4）。

两个明显异常点：

- `C55` 图像只有 592²，却比 1000² 的彩色层更慢：**形状层每模块 8×8=64 次双线性采样**，开销与像素数脱钩。
- `G10` 的 detect 为 57 ms，而 `C40` 只有 12 ms：黑白 finder 候选更多，`finderCandidates` 全图逐行扫描的成本更高。

### 2.3 连续多次解码稳定性

`C40`、1007²、512 B、300 次连续解码：

| 指标 | 值 |
| --- | ---: |
| 失败 | 0 / 300 |
| 中位数 | 17.1 ms |
| p95 / p99 / max | 23.2 / 27.5 / 29.6 ms |
| 变异系数 CV | 12.7% |
| 漂移（最后一批/第一批） | **-3.8%** |
| JS heap Δ（GC 后） | **-0.13 MiB** |
| wasm linear memory Δ | **0 B**（28.6 MiB 不变） |
| 批次均值 | 18.3, 20.1, 17.3, 16.8, 16.9, 17.6 ms |

> 惰性变体后，重复解码的 p99 从 300–400 ms 级降到约 20–30 ms；前几批略慢是 JIT/缓存预热，漂移为负（越来越快）。

结论：**没有随时间退化或泄漏**；p99/max 的尖峰来自 GC——一次 1024² 解码外部内存瞬时增加约 **53 MiB**（预处理会同时构造 16 个 mask/threshold/integral 数组）。

### 2.4 阶段拆解（C40，512 B）

| 阶段 | 中位数 | 占 `decodeAuto` |
| --- | ---: | ---: |
| `preprocessVariants`（急切构建 16 个变体） | **321.1 ms** | 参考 |
| `detectSymbol`（给定变体） | 13.1 ms | 参考 |
| `decode`（给定变体，含 detect） | 15.9 ms | 参考 |
| `decodeAuto`（惰性变体） | **16.8 ms** | **100%** |

惰性化后，清图只构建第一个命中的变体，重复解码稳定在 ~17 ms；急切构建全部 16 个变体仍是 **321 ms**，比实际需要高 **19.1×**。

### 2.5 版本扩展（G20，固定 8 px 模块）

| ver | N | 图像 | 中位数 | Mpx/s | ns/module |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 4 | 33 | 296² | 24.5 ms | 3.58 | 22.5 µs |
| 8 | 49 | 424² | 52.3 ms | 3.44 | 21.8 µs |
| 12 | 65 | 552² | 95.0 ms | 3.21 | 22.5 µs |
| 16 | 81 | 680² | 152.4 ms | 3.04 | 23.2 µs |
| 20 | 97 | 808² | 236.9 ms | 2.76 | 25.2 µs |

耗时基本随像素数线性增长；每模块约 22–25 µs，说明成本完全由图像面积/预处理决定，而不是模块数。

### 2.6 性能提升空间（按收益排序）

1. **按需构建二值化变体（已实施，收益最大）**
   - 已把 `preprocessVariants` 拆成 `createPreprocessor` 惰性工厂：`decodeAuto` 只在尝试某个变体时构建它，命中即停；gray/value/integral 仍按需 memoise。
   - 1024² C40：`decodeAuto` 从 ~270 ms 降到 **16.8 ms（19.1×）**；300 次重复解码中位数 17.1 ms、p99 27.5 ms、heap 无增长。
   - 剩余：C55 形状层仍 322.8 ms（每模块 64 次采样），见第 4 条。

2. **把 WASM 作为默认解码路径（已可用，收益 6–20×）**
   - `decodeAutoWasm` 在 C40 上 13.6 ms，已优于 jsQR（20–45 ms）。
   - 注意：WASM 不处理 constraint 层（返回 `null`），需要 JS 兜底；`decodeAutoWasm` 失败/`null` 时再走 JS。

3. **复用预处理缓冲区 / 对象池（降 p99）**
   - 每次解码分配 16 个 mask、8 个 integral 等大数组，导致 p99 比中位数高 17–52%，max 370–700 ms（跨运行）。
   - 建议在解码器实例级别复用 `gray/integral/mask/threshold` 缓冲（按最大尺寸扩容），可显著降低 GC 次数和 RSS 抖动。

4. **形状层采样降本（C55 预计 2–4×）**
   - `sampleModuleGrid` 每模块 64 次 `sampleImageBilinear`；`C55` 592² 仍要 414 ms。
   - 建议：gridN 从 8–16 降到 4–8；用可分离 box 平均或整数采样代替逐点双线性；先做全模块均值/方差筛选，低置信度模块再用高分辨率网格。

5. **G10 finder 扫描优化（预计 1.5–2.5×）**
   - 黑白层 finder 候选远多于彩色层，`detectSymbol` 57 ms vs 12 ms。
   - 建议：限制候选数量、按 run-length 中心做局部验证后再 `finderScore`、用整型阈值查表替代逐像素函数调用。

6. **编码侧小优化（10–30%，低优先级）**
   - `encode()` 里 `generatePalette` 调用了两次；`render()` 每模块分配颜色数组并逐像素写入；`chooseVersionAndScale` 对每个候选版本重建 layout/Hilbert 序。可缓存 `(N, layer)` layout、复用 palette、用 `fill()` 画整模块。

---

### 2.7 真实场景退化（C/WASM）

旧版性能测试使用的是**直接编码的清图**，不能代表拍照/打印链路。新增 `scripts/bench-camera.mjs`：同一张码经过偏色、光照渐变/暗角、离焦/运动模糊、传感器噪声、距离降采样、旋转、透视和 JPEG 压缩后，用 **C/WASM `decodeAutoWasm`（detector=auto）** 解码；QR-M 以相同模块像素尺寸生成并经过**完全相同**的退化作为对照。

Fixtures：`G10/G20/C40` v8 @12 px，`C33` v8 @16 px，96 B 随机载荷，3 seeds，共 26 种条件。下表为跨层聚合；`C ms` 只统计成功样本。

| 条件 | C ok % | C 错解 | C 中位 ms | QR ok % | QR 中位 ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| clean | 100 | 0 | 10.7 | 100 | 14.6 |
| 偏色 warm / cool / red | 100 | 0 | 10.5–10.6 | 100 | 11.8–13.0 |
| 光照渐变 + 暗角 | 100 | 0 | 10.0 | 100 | 11.8 |
| 离焦 σ=1 | 100 | 0 | 8.9 | 100 | 14.0 |
| 离焦 σ=2 / σ=3 | 75 / 75 | 0 | 9.4 / 20.1 | 100 / 100 | 14.3 / 13.0 |
| 运动模糊 7 / 13 px | 75 / 75 | 0 | 10.8 / 21.9 | 100 / 100 | 12.1 / 12.9 |
| 噪声 σ=10 / σ=25 | 100 / 100 | 0 | 10.2 / 11.5 | 100 / 50 | 11.7 / 45.0 |
| 降采样 0.5 / 0.35 | 75 / 75 | 0 | 2.8 / 1.9 | 100 / 100 | 4.0 / 2.6 |
| 旋转 5° / 10° / 12° | 100 / 100 / 100 | 0 | 38.1 / 35.1 / 40.7 | 100 / 100 / 100 | 24.6 / 21.2 / 17.0 |
| 旋转 15° / 20° | 100 / 100 | 0 | 110.9 / 31.4 | 100 / 100 | 17.2 / 18.6 |
| 透视 0.05 / 0.12 | 100 / 100 | 0 | 32.4 / 27.0 | 100 / 100 | 12.1 / 12.6 |
| JPEG q80 / q50 / q25 | 100 / 100 / 100 | 0 | 10.3 / 10.3 / 10.1 | 100 / 100 / 100 | 15.7 / 22.6 / 19.9 |
| combo-mild | 100 | 0 | 8.9 | 100 | 14.8 |
| combo-harsh | 75 | 0 | 22.0 | **0** | - |

关键结论：

- **偏色、光照、噪声、JPEG、透视、组合轻度退化**：C/WASM 全部 100%，且无静默错解。
- **C33 形状层**是唯一在 σ≥2 离焦、运动模糊、0.5× 降采样下失败的层（0/3）；32/8 符号模板需要更锐利的模块，和 README 的“受控/打印、≥16 px”定位一致。G10/G20/C40 在这些条件下仍全通过。
- **旋转问题已修复**：修复前 5° 时 G20 失败、10–15° 全部 0%、20° 反而 100%。根因是缺少 alignment ring 时退回 `darkCorners` 作为第四点，导致尺度/单应性偏差。现在在 JS 和 C 检测器中都增加了 **平行四边形假设**（三角 finder 中心 + `tr + bl - tl`），并与 alignment/dark-corner 假设一起按 finder/timing 分数择优；修复后 5–20° 全部 100%。
- **QR 对照**：噪声 25 时 QR 只有 50%（C33 0/3，G10/G20/C40 各 2/3），combo-harsh 为 0/12；但旋转 5–20° QR 全通过，说明我们的退化没有“故意整死”二维码。
- 所有 26 × 4 × 3 = 312 次 LCC 解码中 **0 次成功但 payload 错误**。

## 3. 安全性

### 3.1 威胁模型

- 不可信输入：任意图像字节、任意 `{width, height, data}`、任意 packed stack/scan 输入。
- 攻击面：`decodePNG`（文件解析）、JS `decode`/`decodeAuto`（图像对象）、C/WASM `lcc_api_decode` / `lcc_api_stack` / `lcc_api_scan`。
- 关注：内存泄漏、越界读写、整数溢出、无限循环/超时、trap、以及“解码成功但内容错误”。
- **本轮起 C/WASM 是主目标**：新增 `wasmraw` fuzz（通过 `wasmExports()` 直接调用 C 导出，绕过 JS 包装）、原生 harness 的 safe/hostile 分层，以及 C 路径的 camera/damage benchmark。JS 测试保留为行为契约和回退路径。

### 3.2 已确认问题（修复前）

以下记录的是修复前复现的发现；修复和回归结果见 3.5。

| 编号 | 严重度 | 问题 | 证据 | 影响 |
| --- | --- | --- | --- | --- |
| S1 | **高（原生）/ 中（wasm）** | 修复前 `lcc_api_decode` 没有 buffer 长度参数，`lcc_prep_init` 直接按 `width*height*3` 读取 | ASan：`heap-buffer-overflow READ` at `lcc_preprocess.c:145`，由 `lcc_api.c:209` 调用；传入 64 B buffer + 1024×1024 dims | 原生库：越界读（信息泄漏/崩溃）；WASM：`memory access out of bounds` trap（DoS） |
| S2 | **高** | 修复前解析器用 `int` 计算 `width * height * 3`，有符号溢出 | UBSan：`lcc_api.c:152:54`（stack）与 **`lcc_api.c:258:54`（scan）**；`npm run test:native:audit` 的 hostile 模式 **20 次迭代内即触发** `536870924 * 12` 溢出 | 可绕过 `nbytes` 校验；wasm32 下 `size_t` 32 位，`total*module` / `w*h*3` 还可进一步溢出成小分配 → 越界写；原生为 UB |
| S3 | **中** | 修复前畸形 `lcc_api_stack` 输入在早期 `BAD_INPUT` 返回时泄漏 `frames`/`dets` | `scripts/audit-wasm.mjs`：100k 次截断输入 → wasm 内存 **+12.79 MB**（约 128 B/次），状态始终 `BAD_INPUT` | 长时间运行的扫描器被重复恶意输入打爆内存（远程 DoS） |
| S4 | **中–高** | 修复前畸形输入导致 trap 后，缓存 wasm 实例不可用 | `npm run audit:wasm`：20 次“畸形 stack → 合法 decode”循环出现 36 次 trap，**仅 4/20 次合法 decode 成功**；`test/security/boundary.test.js` 也可复现连续 trap 后合法 decode 抛 `RuntimeError` | 一次恶意输入即可让常驻扫描器后续全部解码失败（进程级 DoS）；原生对应 allocator/heap 状态损坏风险 |
| S5 | 中 | `decodePNG` 无解压上限、无像素预算、不校验 chunk CRC | 代码审查：`zlib.inflateSync` 无 `maxOutputLength`；`new Uint8Array(width*height*3)` 无上限；IDAT/IHDR 未校验 CRC | PNG 解压炸弹/超大图导致 OOM；损坏文件被静默接受 |
| S6 | 低–中 | JS 解码信任 `image.data.length === width*height*3` | 2048×2048 + 空 data 的 `decodeAuto` 实测约 2 s；1024×1024 + 300 B 约 473 ms | 恶意元数据造成 CPU/内存放大（DoS），JS 本身不会越界 |
| S7 | 低 | 编码器参数校验不完整 | `encode('x', {quietZone:-1})` 成功返回 `quietZone=-1`、图像 1007 px；`version:0` 被当成 auto | 生成静默损坏/裁剪的码；属于调用方契约问题 |

可达性说明：S1/S2/S3 要求调用方能直接控制 C API 的尺寸/缓冲区（原生库消费者、WASM 原始导出、非 JS 绑定）。现有的 `decodeAutoWasm` / `stackCanonicalFramesWasm` 包装器会生成自洽的 packed buffer，正常 JS 调用不会直接命中；但一旦把这些 API 暴露给不可信输入（这正是扫码 SDK 的典型用法），它们就是实际可利用面。

未发现：JS 路径的越界读写、UAF、原型污染；1000 次随机/损坏输入中**没有一次“解码成功但 payload 错误”**（CRC/RS 守住了）。

### 3.3 修复建议（按优先级）

1. **给 C API 增加长度参数**（S1）
   ```c
   int lcc_api_decode(const uint8_t *rgb, size_t rgb_len,
                      int width, int height, int mode);
   ```
   入口先校验 `rgb_len >= (size_t)width * (size_t)height * 3`，并在 `LccImage` 里保存 `data_len`；`lcc_api_stack` 的 frame 同样保存并校验。同步更新 `docs/lib/lcc-wasm.js` 传入 `image.data.length`。

2. **所有尺寸运算改用 `int64_t`/`size_t` 并显式上限**（S2）
   ```c
   if (width <= 0 || height <= 0 || width > INT_MAX / 3 / height) return LCC_BAD_INPUT;
   int64_t bytes = (int64_t)width * height * 3;
   if (bytes > input_len - offset) return LCC_BAD_INPUT;
   ```
   同时限制 `total = N + 2*quiet`、`module`、`width*height`（例如总像素 ≤ 16 MP），并校验 `det.N == version_to_size(clamp(version))`。

3. **统一 cleanup**（S3）：`lcc_api_stack` 的每个 `return LCC_BAD_INPUT` 前释放 `frames`/`dets`，或改成 `goto cleanup`。

4. **PNG 硬限制**（S5）
   ```js
   zlib.inflateSync(raw, { maxOutputLength: MAX_PIXELS * 4 + 1024 });
   if (width * height > MAX_PIXELS) throw new Error('PNG: image too large');
   ```
   并校验每个 chunk 的 CRC，IHDR 尺寸与解压后长度一致。

5. **JS 入口校验**（S6）：`decode`/`decodeAuto` 检查 `data.length === width*height*3`，并限制 `width*height`。

6. **trap 后重建实例**（S4）：C/WASM 调用抛 `RuntimeError` 后丢弃缓存实例，下一次重新 `instantiate`；或修完边界后让 trap 不可达。

7. **编码器参数校验**（S7）：`Number.isInteger(quietZone) && quietZone >= 0`、`version` 必须是 1..100 的整数、`moduleSize` 必须是正整数。

已落地：`test/security/*.test.js` 的 6 个 `test.todo` 已改为实际断言；`scripts/fuzz-native.sh --audit` 的 mismatch/overflow/hostile 探针现在要求“无告警”，并在 CI 中执行。

### 3.4 已验证的安全属性

- 原 `npm test` 中的 8 个 TODO（6 个安全项 + 2 个相机项）已全部转为实际断言；当前 78 个测试全部通过、0 todo。
- 原生 ASan/UBSan **合法输入域** 400 次（含合法多帧 stack）：无报告；修复前 hostile 20 次即复现 `lcc_api_scan` 整数溢出，修复后 hostile 50 次无报告。
- `wasmraw` fuzz 直接调用 C 导出（scan/stack/decode 的有效输入 + 像素/头部变异）75–150 次：未出现 trap；wasm 高水位内存随输入尺寸增长属正常，固定尺寸的 per-call 泄漏由 `audit:wasm` 单独度量。
- 合法路径泄漏：JS 300 次重复解码 heap -0.13 MiB、wasm 0 B；受限 96 MB 堆下 120 次无 OOM。
- 损坏输入：PNG 随机/篡改、图像噪声/翻转/块损坏/平移、frame 单字节翻转均只会抛错或返回原 payload。

---

### 3.5 修复记录与回归（2026-11）

| 项 | 修复 | 回归证据 |
| --- | --- | --- |
| S1 | `lcc_api_decode` / debug API 增加 `rgb_len`；loader 传 `image.data.length`；入口用 `lcc_image_geometry` 校验 `rgb_len >= width*height*3` | 64 B buffer + 1024² dims 返回 `LCC_BAD_INPUT`；native audit 无 ASan 报告 |
| S2 | 新增 `lcc_image_geometry`（`int64_t` 乘法 + `LCC_MAX_PIXELS=32 MP`）；stack/scan 用 `size_t` 校验 `nbytes/offset`；`lcc_stack_frames` 校验 N/version/quiet/module/max_dimension 并限制输出尺寸；JS API 也限制 32 MP | 65536²、`536870924 * 12` 等输入被拒绝；native hostile 50 次无 UBSan/ASan；wasm 无 trap |
| S3 | `lcc_api_stack` 改为统一 cleanup，所有错误返回路径释放 `frames`/`dets` | `audit:wasm` 100k 次畸形输入：wasm 内存增长 **0 B**（修复前 12.19 MiB） |
| S4 | loader 在 `RuntimeError` 后调用 `resetWasmInstance()`；边界修复后此类 trap 本身也不可达 | `audit:wasm` 20/20 合法解码成功，0 trap；`test/security` 验证恶意输入后仍可正常解码 |
| S5 | `decodePNG` 校验 chunk CRC、IHDR 顺序/尺寸、32 MP 上限、`maxOutputLength`，拒绝超量解压 | 随机/篡改 PNG 全部抛错；`maxPixels` 预算测试通过；但仍建议上层限制压缩文件大小 |
| S6 | `validateImage` 在 `decode`/`decodeAuto`/`detectSymbol`/`detectPerspective`/stack 入口校验尺寸、整数性和 `data.length === w*h*3` | 1024² + 300 B、65536² 等输入在分配前立即抛错 |
| S7 | `encode` 校验 width/height/quietZone/moduleSize/version/min/max/seed 为合法整数并限制渲染尺寸 | 负 quietZone、moduleSize 0、version 0、seed -1 均抛带字段名的 `Error` |
| 旋转 | JS + C 检测器增加平行四边形假设（三 finder 中心 + `tr+bl-tl`），与 alignment/dark-corner 假设一起按 finder/timing 分数择优 | 相机基准 5°/10°/12°/15°/20° 全部 100%；`test/perf/camera.test.js` 覆盖 5–20° |

最终回归：`npm test` 78/78 pass；原生 safe 400 次 + hostile 50 次 ASan/UBSan 干净；`audit:wasm` 0 泄漏/0 隔离失败；camera 26 条件除 C33 形状层的模糊/降采样外全部 100%。

## 4. Fuzz 与 property-based test

### 4.1 Fuzz 结果

`node scripts/fuzz-lcc.mjs --iterations 500 --seed 3`（约 38 s）：

| 套件 | runs | ok | rejected | 说明 |
| --- | ---: | ---: | ---: | --- |
| encode | 500 | 155 | 345 | 合法/非法选项混合；全部是带消息的 `Error` |
| decode | 500 | 0 | 500 | 1–48 px 随机图像全部被拒绝 |
| corrupt | 50 | 50 | 0 | 高斯噪声/像素翻转/块替换/平移；**0 次静默错误** |
| png | 500 | 500 | — | 随机字节 + 随机篡改；全部抛错 |
| ecc | 500 | 500 | — | RS/BCH/frame 性质 |
| wasm | 50 | 35 | 15 | 合法 fixture 成功；随机图被拒绝；无 trap |
| **wasmraw** | 75 | 75 | 0 | 直接调用 C 导出：合法 scan/stack/decode + 字节/头部变异；无 trap |
| stack | 25 | 25 | 0 | JS/WASM 多帧叠加 |

另跑过 `--iterations 1000 --seed 7`（7 套件，0 findings）和 `--iterations 300 --seed 5`（含 wasmraw，0 findings）。`corrupt` 套件覆盖 6 个层、4 种损坏模式和 7 档强度；解码成功时必须逐字节等于原 payload，否则记为 finding。原生侧：**合法输入域 400 次 ASan/UBSan 干净；hostile 模式 50 次也无报告（修复后）**。

### 4.2 Property-based 覆盖

- **往返**：随机层/版本/模块尺寸/quiet zone/constraint；空载荷、1 B、ASCII、CJK、二进制；部分经 PNG 编码往返。`decodeAuto` 必须返回精确 payload。
- **不变量**：编码确定性；`image.width == (N+2q)*s`；`functionCount + dataCount == N²`；data 符号在 `[0, palette*shapes)`；`bitsPerModule == log2(palette)+log2(shapes)`（非 constraint）；capacity 随版本单调；`payloadCapacity == kTotal - 13`。
- **边界**：容量正好装满成功、+1 字节失败；版本 1..100 映射双射；seed 按 format blocks 截断（v2/v5 取低 2 位，v10 取低 6 位）；非法 layer/ecc/version/canvas 均抛 `Error`。
- **纠错码**：RS 在 `t=floor(parity/2)` 内全部纠正（120 组随机 n/parity/错误位置）；BCH 接受词必在半径 3 内、拒绝词必在半径 3 外；frame 任意单字节翻转不会返回不同 payload；CRC32 单 bit 敏感；BitWriter/BitReader 任意位宽往返；format band 字段往返 + 3 bit BCH 纠错；rank constraint 在 G20/G30/C40 上可逆；whitening 两次同 seed 还原。
- **可复现性/碰撞/损坏**：见 4.3–4.5；分别覆盖字节级确定性、编码单射、CRC32 碰撞、模块/遮挡/格式带损坏。

### 4.3 可复现性

`test/property/reproducibility.test.js`：

- **同进程矩阵**：80+ 组参数（层 × 版本 1/2/5/10 × seed 0/1/63 × quiet zone 2/4，shape 层 seed=0），每组编码两次，`image.data`、`symbols`、`meta` 的 SHA-256 必须一致。
- **调用顺序无关**：正序编码、插入无关编码、逆序再编码，结果仍与首次一致（排除全局状态污染）。
- **跨进程**：`scripts/lib/repro-child.mjs` 在全新 Node 进程中重跑 12 组参数，两次进程输出逐字节一致。
- **PNG / SVG**：同一结果重复生成，字节一致；PNG 解码回像素与原始图像一致。
- **解码确定性**：同一图像连续解码 5 次，payload 与 meta 完全一致。

结论：在当前平台（Node 26 / macOS arm64）上，**参数一致 → 输出字节一致**。跨 Node 版本、跨 OS、跨 C/WASM 与原生后端尚未纳入，建议作为 CI 矩阵后续补齐。

### 4.4 碰撞

`test/property/collision.test.js` 与报告分析：

**编码碰撞（两个不同 payload/参数生成同一张码）**

- 结构上是单射：frame 头包含 magic/version/layer/flags/**length**/CRC32，payload 原样进入 frame；RS 是系统码（数据段原样保留）→ 不同 frame 必得不同 RS 码字；布局/调色板/映射是确定函数。因此**固定参数下不存在两个不同 payload 编码成同一符号矩阵**。
- 经验验证：G20 v5 固定参数，2000 个随机 payload（长度 8–32 B）的符号矩阵 SHA-256 **无重复**；按码字空间计算的生日碰撞概率 < 2^-40。
- 跨参数：同一 payload 在 57 组（层 × 版本 × seed）下生成 57 张不同的码，且每张都解码回原 payload/层；未发现参数间碰撞。
- 长度不同：length 字段保证 frame 不同；padding 不会把两个不同长度折叠成同一 frame。

**解码误接受（损坏码被解成另一个合法 payload）**

- CRC32 是**错误检测**，不是密码学校验：本测试用 63,761 个随机 12 B payload 自然找到了 CRC32 碰撞（相同 CRC、不同 payload）。
- 但这不构成编码碰撞：两个 payload 的 frame（payload 段不同）和系统 RS 码字不同，编码图像也不同（测试已验证）。
- 对**随机损坏**，误接受概率上界约 2^-32（CRC32）+ RS 误纠概率；1000 次 fuzz + 60 次定向损坏中 **0 次静默错解**。
- 对**主动攻击**，CRC32 不提供任何真实性：攻击者可以直接生成一张编码了任意 payload 的合法码。若用于凭证/支付等场景，必须加 HMAC/数字签名，而不是依赖 CRC32。

**参数别名（不是 payload 碰撞）**：format 字段有截断——v1 只有 1 个 block（没有 seed/constraint/palette），v2/v5 的 seed 只保留低 2 位；v10 使用完整 6 位（输入 0..63，超出直接拒绝）。`paletteMode`/`harmony` 在 shape 层被忽略。因此 `seed=4` 与 `seed=0` 在 v2/v5 会生成**完全相同**的码。这是有效参数归一化，不是两个 payload 碰撞；`meta.seed` 已回写有效值，API 文档应明确“超出字段宽度的参数会别名”。

**格式带碰撞**：两副本 + BCH(15,5) 多数表决；单副本/双副本各 1–3 bit 损坏全部正确解码（见 4.5）。同一层/版本/ECC 下，不同 format 消息的 BCH 码字最小距离为 7，不会因字段编码本身合并。

### 4.5 部分损坏容忍

`scripts/bench-damage.mjs`，C/WASM 解码，v10、3 seeds、模块级损坏（把模块画成另一个调色板符号）/ 连续遮挡 / 格式带位翻转。理论上限来自 RS 每块 `t = floor(parity/2)`；多 bit 层一个模块错误可能影响多个 RS 字节，因此以实测为准。

| 层 | ECC | data modules | RS t 合计 | 100% 可解的最大模块损坏 | 占比 | 首次失败 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| G10 | L / M / Q / H | 2830 | 34 / 52 / 62 / 70 | 16 / 32 / 32 / 64 | 0.6 / 1.1 / 1.1 / 2.3% | 32 / 64 / 64 / 128 |
| G20 | L / M / Q / H | 2814 | 69 / 105 / 123 / 141 | 32 / 64 / 64 / 128 | 1.1 / 2.3 / 2.3 / 4.5% | 64 / 128 / 128 / - |
| C40 | L / M / Q / H | 2770 | 138 / 204 / 240 / 276 | 64 / 128 / 128 / 128 | 2.3 / 4.6 / 4.6 / 4.6% | 128 / - / - / - |
| C33 | L / M / Q / H | 2764 | 207 / 306 / 360 / 414 | 64 / 128 / 128 / 128 | 2.3 / 4.6 / 4.6 / 4.6% | 128 / - / - / - |
| QR-M | M | 1369 | - | 8 | 0.6% | 16 |
| QR-H | H | 2025 | - | 2 | 0.1% | 4 |

- **连续遮挡**：随机 data 区域的 3×3 / 5×5 / 8×8 / **12×12**（≈144 模块，约 5%）在所有层/ECC 下 3/3 解码成功——RS block 交织把连续错误摊到多个块。
- **格式带**：1/2/3 bit 损坏、单副本或双副本，全部 3/3 成功；两副本多数表决 + BCH 半径 3 生效。
- **失败是安全的**：全部损坏试验 **0 次成功但 payload 错误**；失败表现为 RS/CRC 拒绝。
- **当前没有 erasure 输入**：解码器把所有错误当未知错误处理；如果上层能标记“已知损坏模块”（例如多帧方差、检测器置信度），加入 RS erasure 可把可纠能力提升到接近 `2t`（需改 `rsDecode` 接口与多帧路径）。
- 局限：没有系统测试“finder/timing/alignment 被遮挡”的边界；这类损坏会先导致检测失败（安全失败），但需要单独曲线。

### 4.6 盲区

- 未覆盖真实相机照片的自动化回归（`photo/` 被 gitignore；现有 `scripts/bench-real.mjs` 需要手动提供图片）。本轮手动跑 13 张真机照片：8/13 成功；成功的 C33 高像素样例耗时 2.5–7.5 s，失败的 5 张与光照/反光/构图有关，需逐张分析。
- 合成的旋转/模糊是参数化的，不等价于真实镜头的 PSF/滚动快门/自动曝光；需真机矩阵校准。
- 未系统测试 finder/timing/alignment 被遮挡、局部反光/高光削顶、屏幕摩尔纹。
- 未做并发/多 worker 压力、24 h soak、不同 Node 版本矩阵。
- 原生 ASan 只验证了 macOS arm64；未跑 MSan/TSan、AArch64 Linux、Windows、32 位 wasm 内存模型（已由 wasm 侧部分覆盖）。
- 未对 JPEG/HEIC 解码链路、浏览器 `getUserMedia` 路径做 fuzz。
- 未构造真正的 PNG 解压炸弹（避免把测试机打爆），S5 为代码审查结论。
- 碰撞只证明“编码结构单射 + 57 组参数采样”；跨版本/跨参数的全空间证明仍需形式化或穷举小版本验证。

---

## 5. 与 QR Code 的 benchmark

QR 使用 `qrcode` 生成、`jsqr` 解码，ECC M；LCC 使用同等 1024 px 画布与各层默认 ECC。两边都做 PNG 编码后再比较文件体积；耗时取 12 次中位数。**表中的 LCC 解码耗时是 JS 参考实现**（Apple-to-apple 对比同为纯 JS 解码的 jsQR）；C/WASM 的生产路径数字见 2.2。

### 5.1 同载荷对比（节选）

| 载荷 | 编码 | ver / N | 模块 px | 图像 | PNG | bit/module | 编码 | 解码 |
| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 12 B | QR-M | v1 / 21 | 35 | 1015² | 12,272 B | 0.22 | 1.24 ms | 20.0 ms |
| 12 B | LCC G10 | v2 / 25 | 32 | 928² | 12,771 B | 1.00 | 1.31 ms | 15.6 ms |
| 74 B | QR-M | v5 / 37 | 22 | 990² | 16,050 B | 0.43 | 1.29 ms | 23.8 ms |
| 74 B | LCC G10 | v5 / 37 | 24 | 984² | 16,604 B | 1.00 | 2.91 ms | 20.7 ms |
| 400 B | QR-M | v15 / 77 | 12 | 1020² | 18,707 B | 0.54 | 2.76 ms | 25.9 ms |
| 400 B | LCC G10 | v13 / 69 | 14 | 1022² | 19,003 B | 1.00 | 4.64 ms | 48.3 ms |
| 594 B | QR-M | v19 / 93 | 10 | 1010² | 19,255 B | 0.55 | 2.82 ms | 30.1 ms |
| 594 B | LCC C40 | v8 / 49 | 19 | 1007² | 20,464 B | 4.00 | 3.69 ms | 15.5 ms |
| 1200 B | QR-M | v29 / 133 | 7 | 987² | 21,218 B | 0.54 | 5.70 ms | 39.5 ms |
| 1200 B | LCC G10 | v26 / 121 | 8 | 1000² | 20,869 B | 1.00 | 8.75 ms | 114.8 ms |
| 1200 B | LCC C55 | v7 / 45 | 20 | 980² | 97,925 B | 10.00 | 5.52 ms | 842.3 ms |

汇总（LCC G10 / QR-M，全部 7 个载荷）：

| 指标 | 比值 |
| --- | --- |
| 模块数 N | 0.87–1.19×（多数约 **0.90×**） |
| 图像边长 | 0.91–1.05× |
| PNG 体积 | **0.98–1.05×** |
| 编码耗时 | 1.1–2.4× 慢 |
| JS 解码耗时 | **0.78–2.91× QR**（短载荷更快，大载荷约 1.9–2.9× 慢） |
| WASM 解码（参考 2.2） | G10 49.6 ms vs jsQR 20–40 ms；C40 13.8 ms（更快） |

### 5.2 等模块数容量密度

| ver | N | QR-M | LCC G10 | LCC C40 | LCC C55 | LCC C85 | G10/QR | C55/QR |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 21 | 14 B | 7 | 38 | 98 | 120 | 0.50× | 7.00× |
| 2 | 25 | 26 B | 17 | 66 | 163 | 199 | 0.65× | 6.27× |
| 5 | 37 | 84 B | 89 | 300 | 707 | 612 | 1.06× | 8.42× |
| 10 | 57 | 213 B | 270 | 886 | 2,178 | 2,358 | 1.27× | 10.2× |
| 20 | 97 | 666 B | 877 | 2,864 | 7,115 | 8,292 | 1.32× | 10.7× |
| 30 | 137 | 1,370 B | 1,805 | 5,884 | 14,633 | 17,315 | 1.32× | 10.7× |
| 40 | 177 | 2,331 B | 3,052 | 9,924 | 24,804 | 29,496 | 1.31× | 10.6× |

解释：

- **G10 vs QR-M**：小版本时 LCC 因 13 B frame header + 容量按整 RS block 取整而略差（0.50–0.65×）；N≥37 后稳定高出 QR 约 **6–32%**（即便 LCC ECC 20% 高于 QR-M 的约 15%）。
- **彩色层**：C40 约 **4.2×**、C55 约 **10.5×**、C85 约 **11–12.7×** QR-M 的容量密度。代价是色板/拍摄条件更苛刻，且 PNG 文件显著更大（颜色熵高）。
- QR 用 1 bit/module 的 B/W 物理符号，LCC G10 是同一物理量的公平对照；LCC 的优势来自更紧凑的格式带与布局，而不是把更多 bit 塞进同一模块。

### 5.3 结论

- **同尺寸、同黑白条件**：LCC G10 用略少的模块承载同样数据，PNG 体积几乎相同；编码慢约 2×，JS 解码慢约 10×——后者是当前最大的产品化阻碍，WASM 路径可把差距缩到 1–2×。
- **允许彩色/受控条件**：LCC 的容量密度优势是数量级的（C40 4×，C55/C85 10×+），但需要更高模块尺寸、更好的拍摄/打印条件，PNG 体积也相应变大。
- **扫描端**：QR 有成熟硬件/算法生态；LCC 的 JS 解码在惰性化后已与 jsQR 同量级（0.78–2.91×），WASM 在 C40 上更快。建议生产默认 WASM，JS 作为回退。
- **鲁棒性对照**（详见 2.7 / 4.5）：偏色、光照、JPEG、透视、噪声下 LCC C/WASM 与 QR 基本持平或更好；**旋转 10–15° LCC 全失败而 QR 全通过**，是当前最大的场景差距；模块级损坏容忍 LCC 反而更高（1.1–4.7% vs QR 0.1–1.0%）。

---

## 6. 生产可用性保障清单

**结论：代码级阻断项已修复，但仍不建议未经真机验证直接生产上线。** S1–S7 与旋转问题已完成修复和回归；剩余工作主要是覆盖引导 fuzz、真机/打印矩阵、跨平台复现和性能收尾。

已完成：S1–S7、旋转 5–20°、PNG 预算/CRC、JS/编码器参数校验、wasm trap 重建、8 个 TODO 转断言。

### 6.1 上线前必须

1. **确定 C/WASM 为唯一发布路径**：JS 解码只保留测试/回退；发布包默认 WASM，失败后再回退。所有 fuzz/benchmark/安全门禁针对 C/WASM。编码若也要 C 化，需单独实现并纳入同一套门禁。
2. **CI 已接入**：`.github/workflows/ci.yml` 包含 Node 20/22 的单测+property+fuzz、原生 ASan/UBSan、wasm 重建+测试、benchmark smoke 四个 job；后续把真机/打印 corpus 接入即可。
4. **定义错误预算**：每层的最小模块 px、最大旋转/透视/模糊、ECC 策略、允许的静默错误率（必须为 0）。把这些写成可执行的 camera/damage 门禁。
5. **真实设备/打印矩阵**：至少覆盖 3–5 款手机、室内/室外光照、0–30° 角度、20–60 cm 距离、屏幕/纸张/标签、JPEG/HEIC 链路；记录成功率、p95 延迟、误接受次数。现有 `photo/` 真实照片应纳入回归（当前被 gitignore）。

### 6.2 强烈建议

6. **覆盖引导 fuzz**：把 `native/fuzz_harness.c` 升级为 libFuzzer/AFL++ 目标（或接入 OSS-Fuzz），语料 = 合法 packed stack/scan + 编码图像 + 变异；跑 ASan/UBSan/MSan，并覆盖 wasm32 的 32 位 `size_t` 内存模型。当前随机 fuzz 20 次就能触发 `lcc_api_scan` 溢出，说明覆盖引导会很快发现更多边界。
7. **跨平台可复现矩阵**：同一参数在 Node LTS × macOS/Linux/Windows、x64/arm64、C/WASM/原生后端上比对 SHA-256；编码格式冻结后建立 golden vectors（payload/params → 图像 hash），任何变化都必须显式升级格式版本。
8. **碰撞与真实性**：编码映射在固定参数下结构单射，但 CRC32 只做错误检测。若码要用于凭证/支付/防伪，必须加 HMAC/签名；随机损坏的 2^-32 上界不能替代真实性。对“不同参数是否可能生成同一图像”保留 property test（当前 57 组无碰撞）。
9. **损坏/erasure**：为 RS 增加 erasure 输入，利用多帧方差/检测器置信度把可纠能力提升到接近 2t；补充 finder/timing/alignment 遮挡曲线；明确“检测失败”和“纠错失败”的区分。
10. **长期 soak 与恶意输入**：24 h 连续解码 + 随机畸形输入，监控 RSS/wasm 线性内存斜率；生产进程设置输入尺寸/像素上限、单次解码超时、内存上限，trap 后丢弃实例并重建。
11. **性能收尾**：惰性二值化变体已完成（C40 1024² `decodeAuto` ~16.8 ms）；剩余 C55 形状层采样（JS 仍 ~323 ms）和 WASM 默认路径。用 p50/p95/p99 而不是均值做门槛。
12. **CI 趋势门禁**：`bench-lcc` / `bench-camera` / `bench-damage` 接 CI，固定硬件或记录 CPU 型号；QR 对比只做趋势（±20% 告警），LCC 自身做回归阈值；`fuzz-lcc --strict` 与 native safe gate 必须绿。
