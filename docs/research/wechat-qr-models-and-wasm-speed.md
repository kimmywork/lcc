> 命名迁移（2026-11-12）：文中 `L*` 为 legacy 名称；当前规范使用 `G/C` 命名，完整映射见 README 和 `docs/lcc-spec.md`。

# 微信二维码模型能否换成 LCC 的前置，以及 WASM 还能不能再快

> **状态**：研究记录（2026-11-12 最终清理）。finder/SR/MLP 等实验路径已移除；当前默认是 C 实际残差训练的 width8 形状分类器 + 失败回退。第 4 节的三次扫描加速已经进 C 核心；**98–165 ms 是 retry 路径加入前的历史测量**，当前失败帧会走白平衡 + 全解码回退，真实照片约 1.3–13 s，成功帧仍在 240 ms 量级。
> **日期**：2026-11-11
> **范围**：WeChatCV 公开的检测模型和超分模型在做什么、能不能用同一思路减掉 LCC 的前置搜索、当前 C/WASM 扫描慢在哪。
> **结论先行**：可以训练同类的小模型，但它们替换的是“在整张图里找方块”和“把太小的码放大”，不是色偏矫正、形状分类和 RS。LCC 现在解不开的照片，定位已经成功，失败在细笔画被收成空白。检测网帮不上这个失败。超分或一个按模块训练的笔画分类器才对着这个失败。WASM 还能快，而且先快的办法不是上模型：扫描已经找到单应性，解码却把十几种二值化又跑一遍。

---

## 1. 那四个文件是什么

仓库 [WeChatCV/opencv_3rdparty](https://github.com/WeChatCV/opencv_3rdparty/tree/wechat_qrcode) 的 `wechat_qrcode` 分支只有推理文件，没有训练代码，也没有数据集。README 只给出 MD5。2026-11-11 从 raw 地址读到的体积：

| 文件 | 体积 | 作用 |
| --- | --- | --- |
| `detect.prototxt` + `detect.caffemodel` | 权重约 943 KB | 二维码检测 |
| `sr.prototxt` + `sr.caffemodel` | 权重约 23 KB | 2 倍超分 |

OpenCV 的说明和合入说明把两件事分开写：检测网给出包围盒；超分只在码很小的时候放大。后面的定位图形比例、对齐图形和 zxing 解码都还在。见 [opencv_contrib wechat_qrcode README](https://github.com/opencv/opencv_contrib/tree/master/modules/wechat_qrcode) 和 [PR #2809](https://github.com/opencv/opencv_contrib/pull/2809)。

### 1.1 检测网

`detect.prototxt` 的输入是单通道 `1×1×384×384`。主干是带 BatchNorm 的窄卷积，后面是 SSD 头：五组 `PriorBox`，`mbox_conf` / `mbox_loc`，最后一层 `DetectionOutput`，`num_classes: 2`（背景和二维码），NMS 阈值 0.45，置信度阈值 0.2。合入说明写的是 “SSD + MobileNetV2-like backbone”。

运行时并不把原图直接送进 384。`wechat_qrcode.cpp` 里 `applyDetector` 先把画面缩到面积约 `400×400`，再 `detector_->forward`。没有模型时，整张图被当成一个候选框。也就是说，这个网替换的是“图里有没有码、框在哪”，不是解码。

### 1.2 超分网

`sr.prototxt` 的标称输入是 `1×1×224×224`，但 OpenCV 的 `superResoutionScale` 按裁出来的宽高做 blob，所以实际尺寸跟着裁块走。结构是：

1. `3×3` 卷积，32 通道，Leaky ReLU（负斜率 0.05）。
2. 两个 DenseNet 式瓶颈：`1×1` 压到 8 通道，depthwise `3×3`，`1×1` 升回 32，再和前面的特征拼接。
3. `1×1` 收到 32 通道后，stride 2 的反卷积做 2 倍上采样。

合入说明称之为 QRSR。调用条件在 `super_scale.hpp`：只有缩放比是 2、并且裁块几何平均边长小于 **160** 像素时才跑网络；否则 2 倍用三次插值，缩小用面积插值。`getScaleList` 对小于 320 的裁块试 `1.0, 2.0, 0.5`，更大的裁块先试缩小。超分失败或未启用时，解码器照常在插值后的灰度图上跑。

微信自己的工程文（[专知转载](https://www.zhuanzhiai.com/document/44e5dce68f08f31ebf5e6dcf4845c480)，检索于 2026-11-11）补充了 prototxt 里看不到的训练选择：计算留在低分辨率上；输出是高频残差，低频用最近邻放大后相加；损失在 L2 之外用 Sobel 边缘加权，并加了二值模式约束；量化后约 13 KB。他们给出的难例识别率是 bicubic **39.69%** 到这套超分 **60.31%**，iPhone 7 上 100×100 单帧 **6.39 ms**。这组数字只有这一篇转载，没有对上原始实验表，置信度中等。

---

## 2. 和 LCC 前置对得上的部分

LCC 扫描在 `native/lcc_decode.c` 的 `detect_camera_frame`：长边超过 960 先整数缩小，然后按固定顺序试 12 种亮度/二值化（`PERSP_NAMES`），每种都建整图 mask，再做连通域和单应性。第一种找到定位标记就停。

这和微信检测网是同一段工作：少做整图搜索，直接给出码的四边形。LCC 有编码器，合成图带单应性标签，训练一个同类小检测器在数据上是做得到的。输入用亮度即可，因为定位图形是黑白的，色偏不该进这一步。

对不上的部分：

- 微信的网是灰度、两类、为 QR 的 1:1:3:1:1 定位图形训练的。LCC 的定位图形比例不同，颜色模块会干扰一个没见过彩色码的检测器。直接加载 `detect.caffemodel` 没有依据，需要用 LCC 合成图重新训练，或至少做一次迁移并在实拍上计数。
- 检测成功之后，LCC 还要读格式、做分通道白平衡、对八个笔画模板做相关、再分类颜色。这些不在那两个模型里。
- 当前解不开的实拍（IMG_5055、5057、224813 一类）格式和版本已经读出，错的是笔画被收成空白，然后分块 RS 超预算。换一个更快的框，解出来的符号还是那些错符号。

---

## 3. 超分能不能减前置

能减的是“模块短边小于 12 就锐化”这一段启发式，以及一部分笔画变空。不能减白平衡和颜色分类。

微信的 QRSR 假设码是黑白、下一步要二值化、边缘比像素值重要。LCC 的形状层要保住笔画的方向，颜色要取笔画外面的像素。若把整块彩色码送进一个灰度 2 倍网络，颜色来源就没了。比较贴的做法是只对亮度残差做超分或去模糊，颜色仍从原图、模板以外的像素取。这一步应该发生在单应性对齐之后的模块网格上，而不是对 1600 像素的整张照片做。网格边长通常是几百像素，和他们 “小于 160 才跑、100×100 约 6 ms” 的用量同一量级。

训练数据不用另拍。编码器按 `size/8` 画出八种笔画，再叠屏幕模糊、透视、压缩和实测过的白平衡残差，目标是对齐后的清晰亮度。损失应偏边缘和“相关是否还选对笔画”，而不是自然图像的 PSNR。他们用边缘加权把识别率再抬了约 0.8 个点，这个方向和 LCC 的失败模式一致；数字本身是 QR 上的，不能直接当成 LCC 的预期。

另一条更小的模型可能比整块超分更值：每个模块一张 16×16 或 24×24 的亮度残差，输出 8 类笔画。它直接替换 `match_shape` 的归一化相关，也就是现在把细笔画收成空白的那一步。超分是在进分类器之前把图变清楚；这个分类器是让决策本身扛住模糊。两者可以只做其中一个。在没有实拍对照之前，不能说哪一个纠错字节会降到 RS 预算以内。

---

## 4. WASM 还能不能更快

能。干净 L3s 已经在几十毫秒，慢的是实拍扫描的重复工作，不是模板相关本身。同一台机器上测过：

| 路径 | 耗时 |
| --- | --- |
| 800 像素 L3s，轴对齐解码 | 约 26 ms（JS 约 213 ms） |
| 同一张图，侦测加解码 | 约 40 ms |
| 1600 像素 IMG_5056，单帧扫描并解出 | 约 356 ms |
| 解不开的 1600 像素实拍 | 约 0.8–3.2 s |

上面是改扫描路径之前的计时。当时 `lcc_scan_frames` 先 `detect_camera_frame`，再 `lcc_stack_frames`，然后调用 `lcc_decode_image`。单帧不重采样，于是模式是透视（`mode == 2`）。`lcc_decode_image` 不使用刚才的 `LccFound`，而是对原图再走 `PERSP_NAMES`。每一种二值化只要定位成功，就会做一遍完整的网格采样、模板匹配和 RS。定位对了但 RS 失败时，后面的十几种还会再做一遍。解不开的那几秒主要是这个循环，不是一次相关算不完。

因此速度上的顺序是：

1. 扫描已经得到单应性时，只解码这一次。失败路径应从数秒回到一次解码的量级。这不改变符号对错。
2. 对齐之后按网格取一块整数采样，不要对每个子格的每个点重新做透视除法。356 ms 里的大头在 1600 像素上的双线性采样。
3. 相关、采样和缩小用 WASM SIMD。这一项要重新计时，不能事先写成“再快几倍”。
4. 检测网放在这些后面。它替换的是 12 次 mask 搜索里“第一次就找到”之前的那几次。成功路径上第一次往往已经找到，网的推理还要自己花时间。用它来压 40 ms 的干净路径，不划算。用它来对付定位图形被屏幕摩尔纹打断、经典搜索找不到的情况，才划算。

在浏览器里跑 943 KB 的 SSD，还要带一个通用 ONNX/Caffe 运行时，启动和内存会盖过现在的 `lcc.wasm`。若以后做检测网，应是一个固定输入、手写或专用算子的小网，而不是把 OpenCV DNN 编进页面。23 KB 的超分网更接近能放进页面的体积，但那是 QR 的权重，不能直接拿来恢复 LCC 的彩色笔画。

---

## 5. 建议的下一步

第 4 节的三项已在 2026-11-11 落地，并用 emcc 的 wasm SIMD 重新计时。800 像素 L3s 轴对齐解码约 20 ms，侦测加一次解码约 30 ms。1600 像素的合成码扫描约 29 ms，两帧合成约 37 ms。IMG_5056 仍解出，约 216 ms。解不开的 IMG_5055、224813 当时分别约 165 ms、98 ms（**retry 路径加入前的历史测量**；当前失败帧会走白平衡 + 全解码回退，约 1.3–13 s）。干净图的 payload 与 JS 一致。模型实验仍分开做。

## 来源

- <https://github.com/WeChatCV/opencv_3rdparty/tree/wechat_qrcode>，`detect.prototxt`、`sr.prototxt`，权重体积于 2026-11-11 用 raw 的 `Content-Length` 读取
- <https://github.com/opencv/opencv_contrib/blob/4.x/modules/wechat_qrcode/src/wechat_qrcode.cpp>
- <https://github.com/opencv/opencv_contrib/blob/4.x/modules/wechat_qrcode/src/scale/super_scale.cpp>
- <https://github.com/opencv/opencv_contrib/blob/4.x/modules/wechat_qrcode/src/scale/super_scale.hpp>
- <https://github.com/opencv/opencv_contrib/pull/2809>
- <https://www.zhuanzhiai.com/document/44e5dce68f08f31ebf5e6dcf4845c480>
- 本仓库 `native/lcc_decode.c` 的 `PERSP_NAMES`、`detect_camera_frame`、`lcc_scan_frames`
