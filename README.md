# LCC — Layered Chromatic Code

> ⚠️ **测试阶段警告**
>
> LCC 目前是研究 / 参考实现，**编码格式、层表、色板、格式带、约束方案随时可能完全更改**。
> 请不要用于生产、长期存档、支付、身份凭证或任何不可恢复的数据。请谨慎使用。

LCC 是一套方形、分层、按信道能力换符号表的二维图形码。旧 HLC（Hexagonal Layered Code）六边形实现已删除，设计文档见 [LCC 规范](docs/lcc-spec.md)。

## 层级

### 命名规则

层名直接编码两个维度：

- `G<色彩位宽><符号位宽>`：灰度层；
- `C<色彩位宽><符号位宽>`：彩色层；
- 第一位是 `log2(色板大小)`，第二位是 `log2(符号数)`，`0` 表示无符号图案。

例如 `G13` = 黑白（1 bit）+ 8 符号（3 bit）；`C55` = 32 色（5 bit）+ 32 符号（5 bit）。旧 `L*` 名称保留为别名，完整映射见本节末尾。

### 基础层：无符号图案

| 层 | 符号表 | bit/模块 | ECC | 摄像头建议 |
| --- | --- | --- | --- | --- |
| **G10** | 2 态黑白 | 1 | 20% | **首选** |
| **G20** | 4 级等 L\* 灰 | 2 | 20% | **推荐** |
| **G30** | 8 级等 L\* 灰 | 3 | 30% | 受控拍摄 |
| **C40** | 16 色 max-min ΔE | 4 | 35% | **摄像头彩色首选** |
| **C50** | 32 色 max-min ΔE | 5 | 40% | 受控拍摄 |
| **C60** | 64 色 max-min ΔE | 6 | 40% | 清洁/数字/打印 |
| **C80** | 256 色 max-min ΔE | 8 | 40% | 清洁/数字/打印 |
| **File** | 24bit 真彩 | 24 | CRC32 | 纯数字，独立模式 |

### 形状层

经典形状层在每个模块内叠加 8 种图案之一：空白、`/`、`\`、`X`、`+`、`-`、`|`、`□`，增加 3 bit/模块。富形状层使用 32 种符号，增加 5 bit/模块。图案使用与背景色对比度最高的前景色（互补色，或黑/白）。

> 形状层使用格式 seed 字段的低 2 位作为层变体，固定白化 seed 0；`options.seed` 对形状层必须为 0。旧版本用非零 seed 写出的形状码不兼容，需要重新生成。

| 层 | 基础色板 | 符号 | bit/模块 | 建议 |
| --- | --- | ---: | ---: | --- |
| **C20** | 4 色 | 无 | 2 | 受控/数字 |
| **C23** | 4 色 | 8 | 5 | 受控/打印 |
| **C25** | 4 色 | 32 | 7 | 数字/打印，模块 ≥16 px |
| **C30** | 8 色 | 无 | 3 | 8 色基础层 |
| **C33** | 8 色 | 8 | 6 | 彩色摄像头首选 |
| **C35** | 8 色 | 32 | 8 | 数字/打印，模块 ≥16 px |
| **C40** | 16 色 | 无 | 4 | 摄像头彩色 |
| **C43** | 16 色 | 8 | 7 | `N≥25`，受控/打印 |
| **C45** | 16 色 | 32 | 9 | 数字/打印，模块 ≥16 px |
| **C50** | 32 色 | 无 | 5 | 受控拍摄 |
| **C53** | 32 色 | 8 | 8 | 数字/打印，模块 ≥16 px |
| **C55** | 32 色 | 32 | 10 | 数字/打印，模块 ≥16 px |
| **C60** | 64 色 | 无 | 6 | 清洁/数字/打印 |
| **C63** | 64 色 | 8 | 9 | 数字/打印，模块 ≥16 px |
| **C65** | 64 色 | 32 | 11 | 数字/打印，模块 ≥16 px |
| **C80** | 256 色 | 无 | 8 | 清洁数字/打印 |
| **C83** | 256 色 | 8 | 11 | 清洁数字/打印，`N≥33` |
| **C85** | 256 色 | 32 | 13 | 清洁数字/打印，`N≥33` |
| **G13** | 黑白 | 8 | 4 | 灰度摄像头 |
| **G15** | 黑白 | 32 | 6 | 数字/打印，模块 ≥16 px |
| **G23** | 4 灰 | 8 | 5 | 灰度摄像头/打印 |
| **G25** | 4 灰 | 32 | 7 | 数字/打印，模块 ≥16 px |
| **G30** | 8 灰 | 无 | 3 | 受控拍摄 |
| **G33** | 8 灰 | 8 | 6 | 受控拍摄/打印 |
| **G35** | 8 灰 | 32 | 8 | 数字/打印，模块 ≥16 px |

### 1–13 bit 阶梯

| bit/模块 | 方案 |
| ---: | --- |
| 1 | G10（黑白） |
| 2 | G20（4 灰）或 C20（4 色） |
| 3 | G30（8 灰）或 C30（8 色） |
| 4 | G13（黑白 + 8 符号）或 C40（16 色） |
| 5 | G23（4 灰 + 8 符号）、C23（4 色 + 8 符号）或 C50（32 色） |
| 6 | G33（8 灰 + 8 符号）、C33（8 色 + 8 符号）、G15（黑白 + 32 符号）或 C60（64 色） |
| 7 | G25（4 灰 + 32 符号）、C25（4 色 + 32 符号）或 C43（16 色 + 8 符号） |
| 8 | G35（8 灰 + 32 符号）、C35（8 色 + 32 符号）、C53（32 色 + 8 符号）或 C80（256 色） |
| 9 | C45（16 色 + 32 符号）或 C63（64 色 + 8 符号） |
| 10 | C55（32 色 + 32 符号） |
| 11 | C65（64 色 + 32 符号）或 C83（256 色 + 8 符号） |
| 13 | C85（256 色 + 32 符号） |

> 形状层需要更大的模块：4 px 只适合纯颜色层；8 符号层 **16 px 是摄像头最低建议**，32 符号层同样最低 16 px，且只用于数字/打印/受控场景。不指定 `moduleSize` 时，`fill` 模式会优先选能放下的最大模块（更少元素、更大的方块）。数字/打印至少 8–12 px。
> 小载荷下 C43 也会自动用大模块（例如 1024 画布、12 B 载荷 → v2 / N=25 / 32 px）；只有大载荷时才会降到 16 px 左右。

色板的**最小两两 ΔE** 决定摄像头鲁棒性（实测）：

| 层 | 最小 ΔE |
| --- | ---: |
| G20（4 灰） | 33.2 |
| G30（8 灰） | 14.2 |
| C30（8 色） | 80.2 |
| C40（16 色） | **48.8** |
| C50（32 色） | 35.7 |
| C60（64 色） | 25.0 |
| C80（256 色） | 13.7 |

> 16 色比 16 灰更稳，是因为彩色是三维空间；64/256 色太密，只适合清洁/数字/打印。
> 灰度层的校准枢纽显示该层自身的 4/8 级灰；彩色层才使用 16 级参考灰。

### Legacy 命名映射

| Legacy | Canonical | Legacy | Canonical |
| --- | --- | --- | --- |
| L1 | G10 | L1s | G13 |
| L2a | G20 | L2s | G23 |
| L2b | G30 | L3s | C33 |
| L3b | C30 | L3t | C43 |
| L3c | C40 | L1u | G15 |
| L3d | C50 | L2u | G35 |
| L4e | C60 | L3u | C55 |
| L4f | C80 | L4eS | C65 |
|  |  | L4fS | C85 |

> **优化范围**：摄像头扫描优化只针对基础层和 8 符号层。C60/C80 和 32 符号层按数字/打印 profile 处理，不参与 finder、RS erasure 和廉价分类器的扫描优化。

## 快速开始

需要 Node.js ≥ 18。

```bash
npm run demo                 # 生成下面 5 个基础文本示例
npm run shape:examples       # 生成前 4 个文本的形状层示例
npm run shape32:examples     # 生成 32 符号层示例（G15/G25/G35/C25/C55/C65/C85）
npm test                     # 测试
npm run build:wasm           # 编译两个 C 核心：docs/lib/lcc-decoder.wasm + lcc-encoder.wasm（有 emcc 用 Emscripten，否则用 zig）
npm run build:web            # 复制浏览器核心到 docs/lib（保留 wasm）
npm run web                  # http://localhost:8080
```

性能、稳定性、安全与 QR 对比测试：

```bash
npm run test:property        # property-based：往返、容量、ECC、格式带
npm run test:fuzz            # 随机输入 fuzz（--iterations/--seed 可调）
npm run test:security        # 内存泄漏、受限堆、边界/恶意输入
npm run test:repro           # 参数/跨进程可复现性与碰撞检查
npm run test:native          # 原生 ASan/UBSan 门禁（需要 clang）
npm run test:native:audit    # 攻击探针：buffer 长度、整数溢出
npm run audit:wasm           # 畸形 WASM 输入的泄漏/状态隔离审计
npm run bench                # 性能基准（C/WASM 解码为主）-> bench-results/perf.json
npm run bench:camera         # 偏色/模糊/透视/旋转/JPEG/降采样等真实退化
npm run bench:damage         # 模块级损坏、遮挡、格式带损坏的容忍曲线
npm run bench:qr             # 与 QR Code 的编解码/分辨率/密度对比
```

`bench:qr` / `bench:camera` 需要先 `npm install`（devDependencies：`qrcode`、`jsqr`、`jpeg-js`）；`test:native` 需要 clang。CI 配置见 `.github/workflows/ci.yml`；最近一轮结果、修复记录与剩余风险见 [测试报告](docs/research/lcc-test-report-2026-11.md)。

> 输入上限：C/JS 解码器默认拒绝超过 32 MP 的图像；真实高像素照片应先在调用方降采样。

QR 对比图用 [segno](https://pypi.org/project/segno/) 生成，仅用于文档，不是 LCC 依赖：

```bash
python3 -m pip install segno
npm run qr:examples
```

## 示例

下面 5 个文本使用不同的 LCC 层；QRCode 列使用相同文本、error level M 生成。  
**金刚经数据量过大，不展示 QRCode**，这正是 C80 容量优势的场景。

| 文本 | 大小 | LCC | QRCode | 说明 |
| --- | ---: | --- | --- | --- |
| **Hello World!** | 12 B | <img src="demo_outputs/hello_world_G10.png" width="170"><br>G10 · v2 / N=25 · 17px · ECC L | <img src="demo_outputs/qr_hello_world.png" width="170"><br>QR v1 · 21×21 | 最小黑白码 |
| **The quick brown fox jumps over the lazy dog.** | 44 B | <img src="demo_outputs/quick_brown_fox_G20.png" width="170"><br>G20 · v2 / N=25 · 17px · ECC L | <img src="demo_outputs/qr_quick_brown_fox.png" width="170"><br>QR v4 · 33×33 | 4 级灰，摄像头友好 |
| **Lorem ipsum**（完整段落） | 446 B | <img src="demo_outputs/lorem_ipsum_C40.png" width="170"><br>C40 · v7 / N=45 · 20px · ECC Q | <img src="demo_outputs/qr_lorem_ipsum.png" width="170"><br>QR v16 · 81×81 | 16 色，min ΔE ≈ 49 |
| **心经** | 944 B | <img src="demo_outputs/heart_sutra_C50.png" width="170"><br>C50 · v10 / N=57 · 16px · ECC H | <img src="demo_outputs/qr_heart_sutra.png" width="170"><br>QR v25 · 117×117 | 32 色，受控拍摄 |
| **金刚经** | 20406 B | <img src="demo_outputs/diamond_sutra_C80.png" width="170"><br>C80 · v45 / N=197 · 10px · ECC H | 不展示（20 KB，QR 会非常密） | 256 色，清洁/数字/打印 |

## 形状层示例

下面 4 个文本使用带图案的形状层；图案为 `blank / \ X + - | □` 之一，每个模块额外 3 bit。  
前四个基础示例都有对应的形状版本，全部 `decoded=OK corrected=0`。金刚经 20 KB 仍用 C80（C43 7-bit 在 2048/16px 下容量不足）。

| 文本 | 大小 | 形状层 | 图案 |
| --- | ---: | --- | --- |
| **Hello World!** | 12 B | <img src="demo_outputs/hello_world_G13.png" width="170"><br>G13 · v2 / N=25 · 17px · 4 bit | 黑白 + 8 形态 |
| **The quick brown fox jumps over the lazy dog.** | 44 B | <img src="demo_outputs/quick_brown_fox_G23.png" width="170"><br>G23 · v2 / N=25 · 17px · 5 bit | 4 灰 + 8 形态 |
| **Lorem ipsum**（完整段落） | 446 B | <img src="demo_outputs/lorem_ipsum_C33.png" width="170"><br>C33 · v5 / N=37 · 24px · 6 bit | 8 色 + 8 形态 |
| **心经** | 944 B | <img src="demo_outputs/heart_sutra_C43.png" width="170"><br>C43 · v8 / N=49 · 19px · 7 bit | 16 色 + 8 形态 |

生成：

```bash
npm run shape:examples
```

## 32 符号层示例

富形状层在 8 种经典图案上再增加 24 种符号，共 32 种，每个模块额外 5 bit。  
下面七个示例覆盖灰度/彩色、低/中/高色数和 32 符号层，均 `decoded=OK`。32 符号层只面向数字、打印和受控拍摄，模块最低建议 16 px；高密度示例在最小模块附近需要 RS 纠正。

| 文本 | 大小 | 32 符号层 | 图案 |
| --- | ---: | --- | --- |
| **Hello World!** | 12 B | <img src="demo_outputs/hello_world_G15.png" width="170"><br>G15 · v2 / N=25 · 32px · 6 bit | 黑白 + 32 符号 |
| **The quick brown fox jumps over the lazy dog.** | 44 B | <img src="demo_outputs/quick_brown_fox_G25.png" width="170"><br>G25 · v2 / N=25 · 32px · 7 bit | 4 灰 + 32 符号 |
| **Lorem ipsum**（完整段落） | 446 B | <img src="demo_outputs/lorem_ipsum_G35.png" width="170"><br>G35 · v4 / N=33 · 27px · 8 bit | 8 灰 + 32 符号 |
| **心经** | 944 B | <img src="demo_outputs/heart_sutra_C25.png" width="170"><br>C25 · v7 / N=45 · 20px · 7 bit | 4 色 + 32 符号 |
| **Lorem ipsum**（完整段落） | 446 B | <img src="demo_outputs/lorem_ipsum_C55.png" width="170"><br>C55 · v4 / N=33 · 27px · 10 bit | 32 色 + 32 符号 |
| **心经** | 944 B | <img src="demo_outputs/heart_sutra_C65.png" width="170"><br>C65 · v7 / N=45 · 20px · 11 bit | 64 色 + 32 符号 |
| **金刚经** | 20406 B | <img src="demo_outputs/diamond_sutra_C85.png" width="170"><br>C85 · v33 / N=149 · 20px · 13 bit | 256 色 + 32 符号 |

生成：

```bash
npm run shape32:examples
```

## LCC vs QRCode

| 维度 | LCC | QRCode |
| --- | --- | --- |
| 模块 / 符号 | 方形；1–13 bit 阶梯（C80 为 8 bit） | 黑白二值，1 bit/模块 |
| 颜色 | C40/C50/C60/C80 彩色 | 单色 |
| 定位图案 | `1:2:1:2:1` 自定义方环 | `1:1:3:1:1` |
| 校准 | 灰阶/色板校准枢纽 | 无（二值阈值） |
| 纠错 | RS(GF256) + BCH 格式带 + CRC32；L/M/Q/H + Boost | RS + 格式信息；L/M/Q/H |
| 输出 | PNG / SVG | Bitmap / Vector |
| 容量 | 彩色层更高；C80 可放 20 KB 文本 | 单色，容量较低 |
| 摄像头 | G10/G20/C30/C40/C33 可用；形状层需更大模块；多级受反光/削顶影响 | 极成熟，全球通用 |
| 生态 | 测试阶段，无通用扫描器 | ISO/IEC 18004，所有手机支持 |
| 稳定性 | 方案可能完全更改 | 稳定标准 |

> LCC 的彩色层是“用色板间距换容量”：16 色可以比 16 灰更稳，但 64/256 色在摄像头下会迅速变差。QR 用二值换取通用性和鲁棒性。

## 特性

- **方形动态版本**：`N = 21 + 4(v-1)`，`v=1..100`；最小模块 4px，fill 模式自动铺满画布。
- **形状维度**：经典 8 种线形态增加 3 bit/模块；富形状层 32 种符号增加 5 bit/模块，形成 1–13 bit 阶梯。
- **高对比前景**：形状使用背景色的互补色或黑/白中对比度最高的颜色，避免中灰互补色消失。
- **多帧叠加**：摄像头可一次捕获 1/3/5 帧，按检测结果对齐到 canonical 网格后平均，降低随机噪声；统计面板显示帧间 σ。
- **自定义定位图案**：`1:2:1:2:1` 同心方环，和 QR 的 `1:1:3:1:1` 明显区分。
- **BR 对齐图案**：`N≥25` 提供第四个单应锚点。
- **真 RS(GF(256))**：系统码、分块、交织、Berlekamp-Massey 解码。
- **ECC 可选**：L/M/Q/H（20/30/35/40%）+ Boost ECC；同版本内自动提高纠错。
- **高级尺寸控制**：版本范围、静区、模块尺寸可覆盖。
- **SVG / 统计**：矢量输出 + 结构化统计面板。
- **BCH(15,5) 格式带**：双副本多数投票，版本由几何推导。
- **可逆邻差约束**：按层的 rank 数（4/8/16）和 `maxDiff` 参数化。
- **max-min ΔE 色板**：16/32/64/256 色，最小 ΔE 可测。
- **QR 式预处理**：Otsu / Bradley 自适应阈值、闭运算、多假设重试、V 通道 finder 检测、四锚点单应、局部光照归一化、Viterbi 约束修正。
- **零运行时依赖**：Node 端只用内置 `zlib`；浏览器端只用 Canvas。

## CLI

```bash
node src/cli.js encode --input "Hello LCC" --output hello.png --layer G10
node src/cli.js encode --input "彩色" --output color.png --layer C40 --size 1024 --no-constraint
node src/cli.js encode --input "形状" --output shape.png --layer C33 --size 1024 --module-size 16
node src/cli.js decode --input color.png
node src/cli.js info
```

## API

```js
import { encode, decodeAuto } from './src/index.js';

const result = encode('Hello, LCC!', {
  layer: 'C33',           // G10 | G13 | G20 | C30 | C33 | C55 | ... or legacy L1/L2a/L3c/...
  width: 1024,
  height: 1024,
  mode: 'fill',
  paletteMode: 'maxmin',  // 'maxmin' | 'harmony'
  // moduleSize: 16,      // 可选；不填则 auto，优先选能放下的最大模块
  constraint: false,      // 摄像头建议 false
});

const decoded = decodeAuto({
  width: result.image.width,
  height: result.image.height,
  data: result.image.data,
});
console.log(decoded.text);
```

## ECC 与高级选项

| 选项 | 取值 | 说明 |
| --- | --- | --- |
| ECC | `auto` / `L` / `M` / `Q` / `H` | 20% / 30% / 35% / 40% |
| Boost ECC | on / off | 同一版本内选能放下的最高 ECC |
| 版本范围 | 1–100 | 限制自动选档；`version` 可强制指定 |
| 模块尺寸 | Auto / 4–32px | 固定每模块像素；Auto 由 fill/compact 决定 |
| 静区 | Auto / 2 / 4 / 6 | 屏幕默认 2，打印/摄像头建议 4 |
| 输出 | PNG / SVG | SVG 适合打印和排版 |

```js
const result = encode('Hello', {
  layer: 'C40',
  eccLevel: 'Q',       // auto/L/M/Q/H
  boostEcc: true,      // 同版本内尽量提高
  minVersion: 1,
  maxVersion: 100,
  moduleSize: undefined, // 或 4/6/8/...
  quietZone: 4,
});
```

Web 编码面板的“高级设置”里可以直接调这些参数；生成后统计面板会显示 ECC、色板 min ΔE、约束 rank、数据/功能模块、容量等。  
“下载 SVG”输出矢量码面。

## 研究

- [LCC vs Cimbar：差距、形状维度与增强路线](docs/research/cimbar-vs-lcc-and-shape.md)：Cimbar 对比、形状 + 颜色符号设计草案、验证计划与风险。形状维度已按“线形态”方案实现；报告保留为研究记录。
- [微信二维码模型与 WASM 速度](docs/research/wechat-qr-models-and-wasm-speed.md)：检测网和超分网各自替换哪一段、能不能减 LCC 的前置，以及扫描重复解码为什么比模型更值得先做。研究记录，尚未训练或接入。
- [LCC 形状层超分与 finder 检测的小模型实验](docs/research/lcc-cnn-finder-superscale-experiment.md)：用编码器合成数据训练 finder 热图网和 8 形态超分网，手写 C 算子接进 WASM。finder 和超分已证伪并移除；C 实际残差训练的 width8 形状分类器有增益（`blur_shape` 44.6% → 56.7%，真实照片 4/13 → 5/13），作为 shape 层默认路径，模块 <12 px 时回退模板。
- [LCC 编码与解码联合调研报告](docs/research/lcc-encoding-decoding-co-design.md)：把解码侧调研和编码侧可调整空间放在一起。结论是优先做 RS erasure、相机 profile、Gray 映射、亮度/色度分离、形状集/线宽、校准图案和 C 残差分类器；不建议继续加通用 SR、全图 finder 或 Transformer 解码器。
- [LCC 解码器下一阶段深度调研报告](docs/research/LCC_深度调研报告.md)：另一份独立调研，重点是模块错误率 → GF(256) 符号 → RS 预算的链路、打包失配、GMD/擦除和廉价判别器。其 P4/P5 数字需要在 C 实际残差上复核，本文档已记录复核结果。
- [LCC 实验状态与路线](docs/research/lcc-experiment-status.md)：已做/有效/无效/待实验清单，以及当前 feature 开关和下一步建议。

## Web 版 / GitHub Pages

Web 版在 `docs/`：

- `docs/index.html`：编码 + 扫描 UI。
- `docs/app.js`：Canvas 编码、文件上传、摄像头拍照、连续扫描。
- `docs/lib/`：由 `npm run build:web` 从 `src/` 复制。
- `docs/lcc-spec.md`：规范。

部署到 GitHub Pages：Settings → Pages → Source 选 `Deploy from a branch`，目录选 `/docs`。

编码面板包含“高级设置”（ECC、Boost ECC、版本范围、模块尺寸、静区）、统计面板和 PNG/SVG 下载。

摄像头需要 HTTPS 或 localhost。编码面板有：

- **摄像头黑白**：G10 + constraint off。
- **摄像头彩色**：C40 + constraint off。
- **摄像头形态**：C33 + constraint off，模块尺寸 auto。
- **多帧**：1/3/5 帧叠加，默认 3 帧。
- 示例按钮：心经/金刚经使用 C80（高容量）。

## 摄像头与多帧叠加

- 手机摄像头需要 **HTTPS 或 localhost**，并且必须由用户点击后才能请求权限；点击“打开摄像头”或视频区域即可。
- **不要用 `http://192.168.x.x` 测试手机摄像头**：Safari/Chrome 会把它当作不安全上下文并禁用 `getUserMedia`。用 GitHub Pages、Cloudflare Tunnel、ngrok 等 HTTPS 地址，或在电脑上开 `http://localhost:8080`。
- 打开失败时会自动回退约束：1920×1080 → 1280×720 → `environment` → 默认摄像头；权限被拒、无摄像头、被其他应用占用都有对应提示。失败状态会显示 `secure / protocol / mediaDevices / error` 诊断信息。
- “多帧”可选 1/3/5 帧。连续扫描或拍照时，每帧独立检测，按 `version/N` 分组，统一投影到 canonical 模块网格后平均，再交给正常解码器。
- 多帧平均主要降低随机噪声、传感器噪声和压缩噪声；对随机噪声的理论增益约为 `√N`。它不修复运动模糊或失焦。中性色偏由 finder/alignment 的分通道黑白场矫正，不靠多帧平均。
- 编码和解码的生产路径都在 C/WASM：`lcc-encoder.wasm` 负责 frame/白化/RS/约束映射/layout/格式带/渲染，`lcc-decoder.wasm` 负责侦测、合成、约束解码和 RS。单帧和多帧都在 C 里完成透视侦测、合成和解码；画面长边超过 960 像素时先缩小再找定位标记。JS 只保留输入校验和对象/缓冲区转换。
- 多帧叠加要求码面基本静止；未来做动画/喷泉码时，不能把不同 payload 的帧直接平均，必须按帧 ID 分组。
- 扫描统计会显示叠加帧数、canonical 模块尺寸和帧间 σ，作为置信度参考；最终仍由 RS + CRC 校验。

## 摄像头建议

- **G10 / G20 / C30 / C40 / C33**：首选。
- **G30 / C50 / G13 / G23**：受控拍摄，避开屏幕高光和强反光。
- **C43**：受控拍摄/打印，`N≥25`；模块 Auto 优先选更大，最低建议 16 px。
- **C60 / C80**：清洁截图、文件、数字、打印；不建议随手拍。
- **所有 32 符号层**：面向受控/打印/数字；模块最低 16 px，不建议手机随手拍。
- 形状层需要更大模块：4 px 只适合纯颜色层，摄像头建议 16 px。
- 摄像头场景关闭 constraint；清洁数字码可以开启。
- 多级灰/彩在强反光/高光削顶下仍可能丢级；这不是 finder 检测问题，而是多级量化问题。

## 项目结构

```
native/            C 核心；分别编译为 docs/lib/lcc-encoder.wasm 与 docs/lib/lcc-decoder.wasm
src/
  encoder.js         encoder.wasm 的薄封装
  decoder.js         decoder.wasm 的薄封装
  lcc-encoder-wasm.js / lcc-wasm.js  wasm 加载与打包/解包
  layout-api.js      wasm 提供的 layout/palette 辅助 API
  detect-symbol.js   多帧叠加用的定位辅助（不解码载荷）
  detector.js        透视检测 / 单应
  preprocess.js      Otsu / 自适应阈值 / 闭运算 / 多假设
  illumination.js    finder/alignment 分通道黑白场
  local-rank.js      L2 局部 rank 分类
  calibration.js     G10/灰/彩校准
  layout.js          finder / 对齐 / 格式带 / 枢纽 / Hilbert
  palettes.js        gray / max-min ΔE 色板
  shapes.js          8/32 种符号、前景色、2-means/模板匹配
  stack.js           多帧检测、canonical 对齐与平均
  constraint.js      可逆邻差约束（参数化 rank）
  ecc/               GF(256) / RS / BCH / CRC32
  png.js             Node PNG I/O
  index.js           公共 API
docs/                Web 版 + LCC 规范
examples/            文本示例与 Lorem 文本
demo_outputs/        LCC 示例图 + QR 对比图
scripts/             build:wasm / build:web / 本地静态服务 / QR 对比图
```

## 已知限制

- G30/C50 在强反光/高光削顶下仍可能失败；摄像头首选 G10/G20/C30/C40/C33。
- C60/C80 面向清洁/数字/打印，不建议随手拍。
- File Mode（24bit 真彩）尚未实现。
- 形状层已实现完整的 `G/C × 色数 × 0/8/32 符号` 矩阵，但真实相机/打印 benchmark 尚未完成；4 px 模块不支持形状，摄像头建议 16 px。
- `C43`（16 色 + 8 符号，7 bit）需要 `N≥25`；`C83/C85`（256 色 + 8/32 符号）需要 `N≥33`。32 符号层面向数字/打印/受控拍摄。
- 多帧叠加目前是图像空间平均，尚未做逐模块方差/erasure、跨帧跟踪或运动补偿；码面移动、动画码和喷泉码不适用。
- 手机摄像头需要 HTTPS 或 localhost，且需要用户点击授权。
- 多帧/喷泉码尚未实现。
- 打印链路未实测；真实打印需要逐机校准。
- 不做 QR 兼容；finder 比例 1:2:1:2:1。
- 当前处于测试阶段，格式可能完全更改。

## 许可证

MIT
