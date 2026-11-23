> 命名迁移（2026-11-12）：文中 `L*` 为 legacy 名称；当前规范使用 `G/C` 命名，完整映射见 README 和 `docs/lcc-spec.md`。

# LCC 编码与解码联合调研报告

> **状态**：研究记录，2026-11-11；2026-11-23 更新：C 残差分类器与形状维度已实现，RS erasure 与 SR 已证伪，方案状态见第 6 节。
> **范围**：LCC 的形状层、颜色层、RS/BCH、定位图形、多帧，以及 C/WASM 解码器。产品尚未发布，编码策略可以调整。
> **结论先行**：继续堆模型不是主战场。已落地的是 **C 实际残差训练的 width8 分类器 + 8 种线形态 + 32 符号层**；仍有价值的是编码侧 profile、Gray 映射、亮度/色度分离、校准图案，以及多帧符号级后验融合。RS erasure、通用 SR、全图 finder 热图、YOLO、Transformer 解码器都不投入。

---

## 1. 产品约束与目标

- 运行时：浏览器 / WASM，不能依赖 ONNX Runtime、PyTorch、OpenCV DNN。
- 默认包要小：当前 `lcc-decoder.wasm` 约 233 KB（SIMD）；只保留 width8 形状分类器，不再有 feature 开关。
- 训练数据可以大量合成；真实手机照片只做验证。
- 产品未发布，编码格式、形状集、色板、ECC、定位图形、静区都可以改。
- 目标不是论文 SOTA，而是：
  - 干净/中等帧不退化；
  - 真实难帧识别率有可见提升；
  - 失败路径不要从几百 ms 变成几秒；
  - 编码容量、美观、打印/屏幕兼容性可接受。

### 1.1 优化范围（2026-11-11 明确）

| 集合 | 层 | 策略 |
| --- | --- | --- |
| 扫描集 | L1 / L2a / L2b / L3b / L3c / L3d + 8 形状 L1s / L2s / L3s / L3t | 经典 finder、形状分类器、编码 profile、校准的主战场；RS erasure 与 finder CNN 已证伪 |
| 数字/打印集 | L4e / L4f / L3u / L4eS / L4fS + 32 形状层 | 不做摄像头优化；按高分辨率/精确解码处理，优先容量和视觉表现 |
| 边界 | L3d / L3t | 仍会被扫描，但属于受控拍摄/打印，按“受控”而不是“随手拍”优化 |

`L3u` 虽然名字是 L3，但使用 32 形状，按数字/打印处理，不进入扫描优化队列。

---

## 2. 基线（2026-11-11）

| 数据 | 当前 C | C 残差分类器 |
| --- | ---: | ---: |
| 干净轴对齐 240 帧 | 99.6% | — |
| 相机退化 eval 240 帧 | 16.7% / 53 ms | 17.9% / 184 ms |
| 轴对齐退化形状层 240 帧 | 44.6% / 259 ms | **57.5% / 395 ms** |
| 真实照片 13 张 | 4/13 | **5/13** |

模块级形状准确率（只比较 8 形状）：

| 方法 | 准确率 |
| --- | ---: |
| 当前 C `match_shape` | 91.3% |
| 16×16 双线性 + 绝对值 NCC | 87.9% |
| 合成数据训练的 SR | 83.3% |
| C 实际残差分类器 width 16 | 97.0% |
| C 实际残差分类器 width 8 | 96.1% |

关键判断：**形状识别不是唯一瓶颈**。C 在能走到数据模块的帧上形状准确率 91.3%，但端到端只有 44.6%，说明大量失败发生在格式带、颜色、RS 和失败路径早停上。编码侧的很多改动可以直接减少这些失败，而不需要更大的模型。

---

## 3. 失败分解

| 阶段 | 典型失败 | 现有缓解 | 可改编码 |
| --- | --- | --- | --- |
| finder | 摩尔纹、模糊、遮挡导致三环不全 | 12 种二值化、多假设 | 定位图形/静区/对比度/额外 anchor |
| 几何 | 透视、镜头畸变、中心误差 | 三环 + alignment + 版本搜索 | alignment 数量/位置、timing 冗余 |
| 形状 | 细笔画收成空白、X/+、/\\ 混淆 | 模板 NCC、sharpening | 形状集、线宽、亮度对比、Gray 映射 |
| 颜色 | 白平衡、反光、色偏 | 校准 hub、分通道拟合 | 色板间距、亮度/色度分离、校准块 |
| ECC | 局部 burst 错误、RS 超预算 | RS errors only | erasure、交织、UEP、分块 |
| 系统 | 失败路径重复跑 12 变体 | 扫一次解码一次 | 变体排序/早停、缓存 |

---

## 4. 解码侧研究版图

### 4.1 检测 / 几何

- YOLO 系 QR 检测（Ebp-YOLOv5 2024、Vaccine-YOLOv10 2025、C2-YOLOv8-obb 2025）适合 GPU/边缘盒子，轻量模型也在 5 GFLOPs 量级，不适合 140 KB WASM 默认包。
- 两阶段 fiducial 检测（DeepTag 2021/2022）先找 ROI，再在 rectified patch 里回归 keypoints 和 symbols；这个分工适合 LCC。
- YoloTag（2024）在 GPU 上 55 FPS，DeepTag 只有 3 FPS；说明“经典候选 + 轻量局部网络”比“大而全”更现实。

**建议**：不做全图 finder 热图；做“经典连通域候选 → 32×32/64×64 小 verifier/refiner → 几何一致性检查”。

### 4.2 形状识别

- 普通 CNN 分类器是最直接 baseline；C 残差分类器 96–97%。
- Prototype / metric learning（2024）适合类别少、需要置信度的场景；LCC 只有 8 类，且每类有明确几何模板。
- QATM（2019）、TMR（ICCV 2025）、Self-TM（2024）说明：结构化、低语义目标上，可学习模板匹配往往比通用分类器更稳。
- 形状 + 颜色联合建模可共享 trunk，但颜色误差常来自光照，联合训练不一定解决白平衡。

**建议**：分类器输出 8 类概率 + margin；尝试“小 CNN 特征 + 8 个可学习模板/原型”的混合头；颜色保留独立校准路径。

### 4.3 超分 / 去模糊

- PeerJ CS 2025 用 EDSR/VDSR/ESPCN/SRCNN 处理 4,593 张 OpenCV 解不开的真实 QR，EDSR 救回 4,261 张，但单张 0.364 s。
- QRCNN（GCCE 2024）证明模块中心区域比边缘更重要，mask 加权训练可在不增加参数的情况下提升可读性。
- Mosaic-SR（ICIP 2025）按 patch 不确定性决定 refinement 步数，比统一 SR 更快、解码率更高。
- Gs-DeblurGANv2（2024）、EGMSNet（2025）说明轻量去模糊有效，但仍是图像级网络，成本远大于 5k 分类器。

**建议**：文献支持任务感知 SR，但本仓库实测：C 实际残差上 SR 83.3%，不如双线性 87.9%，更不如分类器 96–97%。不要做通用逐模块 SR；若继续，只对低置信模块做，且训练输入必须来自 C 实际残差。

### 4.4 ECC / 软判决

- RS errors-and-erasures：`2e + s <= nsym`。低置信符号标成 erasure，比硬判错误更划算。
- Koetter-Vardy 代数软判决（2003）能利用可靠性，但复杂度高；短 RS 块用 GMD/erasure 通常已能拿到大部分收益。
- 2024 年 `On the Design and Performance of ML Based ECC Decoders`：短/中块长下，OSD 仍优于 ECCT/CrossMPT 等 Transformer 解码器。不要用神经解码器替换 RS。
- 2025 年 Transformer QR 解码器能超过理论纠错上限，但依赖文本结构先验；LCC 是任意 payload + 彩色 + 形状层，不具备同样先验，也不适合 WASM。

**建议（已证伪）**：当时认为最高性价比是“分类器置信度 → RS erasure”；E1 oracle 实测只多救 6/130 个硬帧，失败是灾难性丢符号，因此该方向不再投入。

### 4.5 E0 打包审计（2026-11-11）

外部报告把“模块 → GF(256) 符号”的打包失配放在模型之前，这个方向是对的。我用一个临时审计脚本对当前编码器做了实测（脚本已在最终清理中移除）：每个数据模块的 bit 跨度会触及多少个 RS 字节。

| 层 | bit/模块 | 平均字节/模块 | 最大 | 典型 RS 块 |
| --- | ---: | ---: | ---: | --- |
| L1 | 1 | 1.00 | 1 | 177/142 |
| L2a | 2 | 1.00 | 1 | 235/188 |
| L2b | 3 | 1.25 | 2 | 211/148 |
| L3b | 3 | 1.25 | 2 | 209/146 |
| L3c | 4 | 1.00 | 1 | 231/150 |
| L3d | 5 | 1.50 | 2 | 245/147 |
| L3s | 6 | 1.50 | 2 | 231/162 |
| L3t | 7 | 1.75 | 2 | 241/157 |
| L3u | 10 | 2.00 | 2 | 241/157 |
| L4eS | 11 | 2.25 | 3 | 244/146 |
| L4fS | 13 | 2.50 | 3 | 248/149 |

读法：

- L1/L2a/L3c 的模块基本落在一个字节内，erasure 映射最干净。
- L2b/L3b（3 bit）实测 1.25 字节/模块，比外部报告假设的 1.375 略好。
- L3d/L3s 是 1.5；L3t 是 1.75；L3u 是 2.0；L4eS/L4fS 是 2.25/2.5。
- 所以扫描集里，L1/L2a/L3c 最适合先做 erasure；L2b/L3b/L3d/L3s 需要字节级可靠度；L3t 的 erasure 成本更高。
- L4/32 形状层是数字/打印，不参与这轮扫描优化；它们的 ECC 可以按高分辨率、干净信道的假设单独设计。
- 当前 RS 块长在 170–250，属于长块。短块 RS 会显著改变容量，但确实能提高 burst 容忍度，值得只在扫描集上做离线 A/B。
- 外部报告里基于 3 bit/模块的 s≈1.375 对 L2b/L3b 接近（实测 1.25），对 L3s（1.5）也接近；但不能套到 10/11/13 bit 的富形状层。

### 4.6 高效推理

- WASM SIMD 对卷积普遍有 1.7–4.5× 提升；2025 年跨平台 benchmark 认为可接近 native C 的 1.4× 量级。
- int8 在**没有 SIMD** 的 WASM 上不一定比 float 快；量化要和 SIMD 一起做。
- WebGPU 的优势在中等/大模型；<20 ms CPU 的小模型，GPU 上传/编译开销经常盖过计算。
- TinyML（TinyissimoYOLO、BitNetMCU）证明 8-bit/低比特 + 剪枝 + QAT 可行；但我们的瓶颈更多在“每模块都跑”和“失败路径重复跑”。

**建议**：优先门控/早停、depthwise/separable、Winograd、int8 + SIMD；暂不上 WebGPU。

### 4.7 数据与域适应

- 合成到真实是条码领域成熟路线（barcode benchmark 2020、SYNBAR 2024、mobile screenshot QR 2024）。
- EgoQR（2024）指出广角、畸变、运动模糊、小码是主要问题；多帧/SR 是未来方向。
- 本仓库 C 残差导出证明：训练输入必须来自实际解码链路，否则同一个网络会从 99% 掉到 83%。

**建议**：按帧划分 train/val；训练集包含干净、模糊、透视、色偏、摩尔纹、低模块、失败帧强制对齐残差；真实照片只做验证和阈值校准。

### 4.8 外部报告对照与实测复核

另一份调研报告（`docs/research/LCC_深度调研报告.md`）把“RS 预算 / 打包失配”作为主线，方向与我们的数据一致。可复核的部分：

**一致**

- 当前 C 模板 91.3%、width8 分类器 96.1%、width16 97.0%；端到端 44.6% → 57.5%。
- 瓶颈在符号级/RS 预算，不在 finder；finder CNN、像素 SR、Transformer 解码器都不值得继续。
- 优先做打包/块长审计、廉价判别器、可靠度校准、多帧 F=3、早停；其中 RS erasure 已被本地实验证伪。
- 不建议默认 WebGPU/WebNN；WASM SIMD 是主路径。

**需要修正或补充**

- **P4 投影 + 线性分类器没有复现出 96%+。** 在 367,755 个 C 实际残差上：
  - 68 维投影 + Ridge/Logistic：93.6%；
  - 68 维投影 + 64 隐层 MLP（8 epoch）：95.2%；
  - abs(raw 256) + Logistic：93.9%；
  - **abs(256) + 68 维投影 + 64 隐层 MLP（12 epoch）：96.4%**，约 21k MAC/模块，是 width8 CNN（约 385k MAC）的 1/18；
  - width8 CNN：96.1%。
  方向是对的，但“线性层直接替代 CNN”要降级为“投影 + 小 MLP”。更关键的是：这个 324 维 MLP 在真实照片上只解出 **2/13**，而 width8 CNN 是 **5/13**；它在合成 `blur_shape` 上 56.7%，但域泛化不足。**因此不能默认启用**。
- 进一步补透视残差时发现数据缺口：用现有 debug API + 透视成功帧，只能从 eval 240 帧里拿到 **7 帧 / 6,725 个模块**；绝大多数难帧在格式/RS 就失败，拿不到正确单应性。
- 已加 `lcc_api_debug_residuals_h` 强制对齐导出：用 manifest 的 `homographyModuleFlat` + version/N/moduleSize 直接走 `decode_found`。eval 240 帧拿到 **48 帧 / 102,884 个模块**，其中 30 帧是 8 形状层（47/48 帧 RS 失败）。
- 合并难尾后：
  - width8 CNN：base val 96.13% → 95.96%，forced val 19.58% → 21.20%；
  - cheap MLP：base val 96.33%，forced val **28.41%**（C 模板 17.50%）。
  - 真实照片仍然只有 **2/13**（width8 是 5/13）。
  **结论**：强制残差能显著改善模块级难尾，但真实照片的域偏移仍在；不能只靠合成/eval 残差把 MLP 推成默认。
- 小卷积 stem（1→8→16，global avg+max，约 56k MAC/模块）在合并数据上 base 92.9%、forced 18.4%，不如 cheap MLP（96.3%/28.4%）和 width8（96.0%/21.2%）。**不作为候选**。
- **E1 oracle erasure 最终结果**：先修掉了 `synth.augment` 的 Hinv 归一化 bug（PIL 透视系数要求 `i=1`），131 个强制对齐帧里 130 帧布局一致。硬判决 pass 20/130，oracle erasure pass 26/130，**只多救 6 帧**；大多数失败帧 Uora 仍在 2–5，属于灾难性丢符号。
  结论：**RS erasure 在这批硬帧上没有明显增益，不作为下一阶段优先项**；后续实验里的几何/timing 全局精修同样是净负（真实照片 5/13 → 3/13）。
- **P1 的模块级 erasure 不能直接映射到 RS 字节。** 我们的审计显示 L3s 已是 1.5 字节/模块，L4fS 是 2.5 字节/模块；擦一个模块可能吃掉 2–3 个 RS 符号。可靠度要落到字节/符号级，或者改打包。
- **外部报告的 3 bit/模块数字不能直接套到 32 形状层。** L3u/L4eS/L4fS 是 10/11/13 bit/模块，s=2.0/2.25/2.5，RS 预算模型要按新层重算。
- **“当前 C 91.3%”是成功帧上的条件准确率**，有选择偏差；失败帧残差还没纳入，不能把它当成无偏的模块先验。

**合并后的优先级（只针对扫描集）**

1. E0 打包/块长审计（已完成）。
2. E1 oracle erasure 上界（已证伪：只多救 6/130 帧）。
3. P4/P5 廉价判别器在 C 残差上做端到端 A/B：最后落地的是 width8 CNN + 模板门控；cheap MLP 与小 stem 已证伪。
4. 32 形状层和 L4 不进入扫描优化；它们按数字/打印 profile 单独处理。

---

## 5. 编码侧设计空间（重点）

产品未发布，这部分的空间通常比继续换模型更大。

### 5.1 形状集与几何

当前 8 形状：blank、/、\、X、+、-、|、square，3 bit/模块。

问题：
- X 是 / 和 \ 的并集，+ 是 - 和 | 的并集；模糊下容易互相混淆。
- square 与 blank 在低对比/小模块下也可能混淆。
- 线宽 `size/8`、inset `size/16` 在小模块上只有 1 px，细笔画最先消失。

可选调整：
1. **测量混淆矩阵**：在 C 实际残差上统计 8×8 混淆矩阵，找出真正的混淆对。
2. **减少形状集**：如果 X/+ 或 square/blank 混淆严重，改成 4 或 6 形状集，降低 bit/模块，但用更大模块/更强 ECC 补偿。
3. **替换形状**：用更可分的非对称形状（L、T、dot、ring、双线）替代 X/+；保持 8 类但增大最小特征距离。
4. **加粗/参数化线宽**：按模块尺寸和相机 profile 选择线宽，不固定 `size/8`；小模块用更粗线。
5. **亮度通道承载形状**：形状前景优先选黑/白中亮度对比最大的，而不是最大 ΔE；背景颜色继续承载颜色 bit。这样形状分类器只依赖亮度，颜色校准独立处理。

**实验**：固定容量/版本，枚举形状子集、线宽、前景选择策略，跑 C 残差分类器和端到端 `blur_shape`；目标是找到“bit/模块 × 识别率”的 Pareto 前沿。

**当前落地（2026-11-11）**：32 符号已实现为 `L3u`（32 色 + 32 形状，10 bit）、`L4eS`（64 色 + 32 形状，11 bit）、`L4fS`（256 色 + 32 形状，13 bit）。JS/C 轴对齐 round-trip 和轻度透视 round-trip 已通过；默认仍不用于摄像头 profile，模块最低 16 px。富形状层的 ECC 打包要与打包/块长审计一起设计。

### 5.2 颜色与通道

当前色板是 max-min ΔE；颜色层靠校准 hub 做分通道拟合。

可选调整：
1. **亮度/色度分离**：形状只用亮度，颜色只用色度/背景色；减少形状与颜色的相互干扰。
2. **Gray 映射**：给颜色/形状分配 bit 标签时，让视觉上最接近的符号只差 1 bit；分类器混淆时 RS 看到的是少量 bit 错误，而不是整符号错误。
3. **色板间距按相机噪声加权**：不是只最大化 Lab ΔE，而是最大化“在真实白平衡/噪声分布下的最小可分距离”。
4. **校准块增强**：在 hub 或四角增加已知灰阶/色块/黑白边，估计颜色矩阵和 PSF；当前 hub 已有灰阶/色板，可再加边缘/模糊校准。
5. **颜色数量与模块大小联动**：小模块优先低色数（L1/L2a/L3b/L3c），大模块才用 L3d/L4e/L4f。

### 5.3 码率、ECC 与交织

1. **RS erasure（已证伪）**：E1 oracle 只多救 6/130 帧，不投入。
2. **空间交织**：把同一 RS 块的数据分散到码面不同区域，避免反光/模糊/污损造成局部 burst 集中在一个块。
3. **不等错误保护（UEP）**：格式带/头部用更强保护，payload 用可调码率；格式带读错时整帧失败，值得多给冗余。
4. **分块 CRC**：每块加短 CRC，快速定位坏块，避免整帧 RS 失败。
5. **多帧/增量冗余**：屏幕-相机场景可以每帧变换颜色/形状排列或发送增量冗余，接收端做软合并；这属于编码协议层改动，收益可能大于单帧模型。

### 5.4 定位、同步与校准

1. **finder/alignment 数量与位置**：当前三 finder + 右下 alignment；可以评估增加第四个角 anchor 或中间 anchor，改善大透视/镜头畸变。
2. **timing 冗余**：timing 行/列可用于版本和采样校验；可以加粗或双行。
3. **静区**：相机 profile 建议更大静区；屏幕 profile 可以小一些。
4. **校准图案**：增加已知的斜边/棋盘/形状条，估计 PSF、模糊方向和颜色矩阵；这对“细笔画消失”和“颜色偏移”都是直接信息。
5. **多尺度 finder**：在 finder 外再放一个更粗的环，远处/模糊时先被检测到；代价是占用模块。

### 5.5 编码 profile

建议产品层面显式区分：

| Profile | 目标 | 建议 |
| --- | --- | --- |
| Screen / digital | 容量优先 | 高版本、小模块、L4e/L4f、低 ECC |
| Camera / print | 鲁棒优先 | 低版本、模块 ≥16 px、L1/L2a/L3c/L3s、ECC H、较大静区 |
| Screen-camera | 动态/多帧 | 中等模块、时序冗余、亮度/色度分离 |
| Logo/美观 | 人因优先 | 形状/颜色约束、较低容量、强校准 |

编码器可以根据用途自动选 profile，而不是只按“能放下”选最大模块。

### 5.6 多帧与协议

- 同一 payload 多帧重复时，不要简单图像平均；按模块置信度做软合并/erasure。
- 屏幕-相机场景可利用刷新率/rolling shutter 做时序编码；RescQR（2024）用 Viterbi 恢复 composite frame，说明时序信息有价值。
- 但多帧要求码面基本静止或可跟踪；运动场景需要额外跟踪/补偿。

---

## 6. 方案状态（2026-11）

> 只针对扫描集（基础层 + 8 形状层）。32 符号层和 C60/C80 按数字/打印 profile 单独处理。

| # | 方案 | 状态 | 说明 |
| ---: | --- | --- | --- |
| 1 | RS errors-and-erasures + 分类器 margin | 已证伪 | E1 oracle 在 130 个硬帧上只多救 6 帧；失败是灾难性丢符号，不是“差几个符号”。 |
| 2 | 相机 profile | 未做 | README 目前只有人工层建议（G10/G20/C30/C40/C33）。 |
| 3 | Gray 映射 | 未做 | 需要先测混淆矩阵。 |
| 4 | C 残差分类器 + 原生门控 | 已实现 | width8 + 16×16 模板门控；模块 <12 px 回退模板。 |
| 5 | 亮度/色度分离 | 未做 | |
| 6 | 形状集/线宽 | 已实现 | 8 种线形态 + 32 符号富符号层。 |
| 7 | 校准图案 | 未做 | |
| 8 | 两阶段 finder | 未做 | |
| 9 | 空间交织 / UEP / 分块 CRC | 部分 | RS 块间交织已有；空间交织、UEP、分块 CRC 未做。 |
| 10 | 多帧置信度/erasure 融合 | 部分 | 16×16 子格跨帧中值与帧门控已实现；符号级后验融合未做。 |
| 11 | 量化 / SIMD / 剪枝 | 部分 | 关键内核有 SIMD；int8 分类器未做。 |
| 12 | 任务感知 SR | 已证伪 | 见第 9 节。 |

### 6.1 相机 profile

- 编码器根据用途选择低版本、更大模块、更强 ECC、更大静区。
- 对同一 payload，比较“高容量 profile”和“相机 profile”的端到端识别率/容量。
- 这是产品策略改动，不需要改解码器；收益通常立竿见影。

### 6.2 Gray 映射

- 形状 3 bit、颜色 2–4 bit，符号标签可以重新分配。
- 让视觉上最接近的符号只差 1 bit；分类器混淆时 bit 错误更少。
- 代价是编码表/解码表改动，RS 不变。
- 需要先测混淆矩阵，再按混淆图做标签分配（类似图着色/旅行商）。

### 6.3 亮度/色度分离

- 形状层前景优先选黑/白中亮度对比最大的；背景色继续承载颜色。
- 形状分类器只看亮度残差，颜色校准独立。
- 需要验证：彩色背景下，黑/白前景是否仍然美观；颜色 bit 是否受影响。

### 6.4 校准图案

- 在 hub 或四角加已知斜边/棋盘/灰阶/色块/形状条。
- 解码端估计 PSF、模糊方向、颜色矩阵、局部对比度。
- 对“细笔画消失”和“色偏”都是直接信息；成本是占少量模块。

### 6.5 两阶段 finder

- 经典连通域给候选；小网络在 32×32/64×64 patch 上验证/回归中心。
- 比全图 heatmap 分辨率高、成本低；比 YOLO 更适合 WASM。
- kill criteria：真实难帧 finder 召回没有提高，或增加 >10 ms。

### 6.6 空间交织 / UEP / 分块 CRC

- 空间交织分散 burst；UEP 保护格式带/头部；分块 CRC 快速定位坏块。
- 需要改布局和格式，但收益直接针对 RS 超预算。

### 6.7 多帧符号级后验融合

- 目标是把“每帧的模块似然”跨帧累加后再判，而不是先融合像素；现有实现只做到 16×16 子格中值。
- 需要格式带解出色板后才能做符号级分类，属于独立增量；先积累真实连拍验证集。

### 6.8 量化 / SIMD

- width8 分类器 1.3k 参数，0.77 MFLOP；int8 + SIMD 目标 2–4×。
- 3×3 depthwise/separable、Winograd、im2col；避免无 SIMD 的 int8。
- 量化感知训练，保持 96% 以上。

---

## 7. 剩余路线

只列未做或未完成的方向，按当前优先级：

1. 相机 profile 与 Gray 映射（编码侧，低风险）。
2. 亮度/色度分离、校准图案。
3. 空间交织 + UEP + 分块 CRC。
4. 多帧符号级后验融合（需要真实连拍验证）。
5. int8 + SIMD 分类器；两阶段 finder 仅在出现明确漏检样本时再做。

---

## 8. 实验协议

**数据**
- 按帧划分 train/val，禁止按模块划分。
- `blur_shape` 180 帧训练 + 60 帧验证；失败帧强制对齐后单独做 test-hard。
- 真实照片只做 validation，逐张报告。

**指标**
- 模块级形状/颜色准确率。
- erasure 率、RS 纠正符号数、RS 失败率。
- 端到端 payload 完全一致率。
- finder 三中心召回、中心误差。
- p50/p95/mean 延迟、模型大小、WASM 内存。
- 失败帧的早停位置（finder / format / color / RS）。

**基线**
- 当前 C。
- 16×16 双线性 + abs NCC。
- C 残差分类器。
- 相机 profile vs 高容量 profile。
- Gray vs 非 Gray。

**消融**
- 门控阈值、分类器 width。
- 训练数据是否包含失败帧。
- 形状集/线宽/亮度分离。
- 是否量化/SIMD。

**统计**
- 对帧做 bootstrap，报告 95% 置信区间；不要只报模块级平均。

---

## 9. 不做 / 已证伪清单

已证伪（不要重复投入）：

- RS erasure：E1 oracle 只多救 6/130 个硬帧。
- Cheap MLP 与小卷积 stem：真实域泛化不如 width8 分类器。
- 几何/timing 全局精修：真实照片 5/13 → 3/13，净负。
- 单帧屏幕去纹/反光抑制：现有难例的所有预处理都解不出，改用多帧 + 早停。
- 通用逐模块 SR / EDSR / diffusion SR；任务感知 SR 也没有胜过分类器。

不做：

- 全图 finder heatmap / YOLO 检测器。
- Transformer QR 解码器 / 神经 RS 解码器。
- 为 5k 参数模型上 WebGPU。
- 默认路径引入 ONNX Runtime / 通用推理框架。
- 在未验证的情况下继续加大模型；先用 C 实际残差和编码改动拿到可解释收益。

---

## 10. 主要来源

**检测 / 几何**
- Ebp-YOLOv5, 2024: https://doi.org/10.1007/s11760-024-03564-9
- Vaccine-YOLOv10, 2025: https://github.com/AlexTraveling/Vaccine-YOLOv10
- C2-YOLOv8-obb, 2025: https://doi.org/10.1109/smc58881.2025.11343548
- DeepTag, 2021: https://arxiv.org/pdf/2105.13731v2.pdf
- YoloTag, 2024: https://arxiv.org/abs/2409.02334
- DeepFormableTag, 2022: https://ar5iv.labs.arxiv.org/html/2206.08026

**超分 / 去模糊**
- Reconstructing unreadable QR codes, PeerJ CS 2025: https://pmc.ncbi.nlm.nih.gov/articles/PMC12192636/
- QRCNN mask, GCCE 2024: https://www.ams.giti.waseda.ac.jp/data/pdf-files/2024GCCE_tanaka.pdf
- Mosaic-SR, ICIP 2025: https://prittt.ing.unimore.it/media/publications/pdfs/2025icip.pdf
- Gs-DeblurGANv2, 2024: https://link.springer.com/article/10.1007/s00530-024-01292-1
- EGMSNet, 2025: https://www.mdpi.com/2079-9292/14/7/1298

**ECC / 软判决**
- Koetter-Vardy, 2003: https://doi.org/10.1109/tit.2003.819332
- ML-based ECC decoders, 2024: https://arxiv.org/abs/2410.15899
- ECCT acceleration, 2024: https://arxiv.org/abs/2410.05911
- RS erasure engineering reference: https://merri.cx/qrazybox/help/extension-tools/reed-solomon-decoder.html

**形状 / 模板**
- Prototype networks, 2024: https://doi.org/10.7717/peerj-cs.2322
- QATM, 2019: https://doi.org/10.1109/cvpr.2019.01182
- TMR, ICCV 2025: https://openaccess.thecvf.com/content/ICCV2025/papers/Jo_Few-Shot_Pattern_Detection_via_Template_Matching_and_Regression_ICCV_2025_paper.pdf
- Self-TM, 2024: https://www.mdpi.com/2504-2289/9/2/38

**高效推理**
- WASM SIMD convolution, 2023: https://fukushima.web.nitech.ac.jp/paper/2023_iwait_oishi.pdf
- WASM/ONNX/TVM benchmark, 2025: https://doi.org/10.30574/wjarr.2025.26.2.1832
- WebGPU vs WASM, 2025/2026: https://www.webassembly-wasm.com/production-wasm-workloads-and-deployment/machine-learning-inference-in-the-browser/choosing-between-the-wasm-and-webgpu-backends/
- TinyissimoYOLO, 2023/2024: https://arxiv.org/html/2306.00001
- BitNetMCU, 2024: https://github.com/cpldcpu/BitNetMCU

**数据 / 真实场景**
- Synthetic barcode benchmark, 2020: https://link.springer.com/chapter/10.1007/978-3-030-57058-3_34
- SYNBAR, 2024: http://www.jip.ru/2024/438-448-2024.pdf
- Synthetic mobile screenshot QR, 2024: https://doi.org/10.1109/conecct62155.2024.10677158
- EgoQR, 2024: https://arxiv.org/abs/2410.05497
- RescQR, 2024: https://hhannuaa.github.io/papers/tmc2024_hhan.pdf

---

## 11. 一句话总结

**主线不是“更大的模型”，而是“让码更适合相机、让模型只处理真正困难的模块”。** 已落地的是 C 残差分类器 + 形状维度；仍可尝试的是相机 profile、Gray 映射、亮度/色度分离和校准图案。纠错侧不再投入 RS erasure。
